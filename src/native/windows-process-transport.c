/* Windows 11 x64 owned-process transport; Node-API 8, no V8 or libuv.
 * Only the explicit executable is launched. Each run has its own kill-on-close
 * Job, native coordinator, bounded TSFN queue and independent cleanup bridge.
 * The native thread never waits for JavaScript to perform process cleanup.
 */
#include <windows.h>
#include <node_api.h>
#include <stdint.h>
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

#if NAPI_VERSION != 8
#error Build this transport with Node-API 8
#endif
_Static_assert(sizeof(wchar_t) == 2, "Windows UTF-16 required");

#define WIRE_MAGIC 0x44574654u
#define SNAPSHOT_BYTES 1048576u
#define COMMAND_UNITS 32767u
#define CHUNK_BYTES 32768u
#define QUEUE_ITEMS 4u
#define CLEANUP_MS 2000u
#define JOIN_MS 3000u

typedef struct Run Run;
typedef struct Context Context;
typedef struct { wchar_t *application, *command, *cwd, *environment; } Snapshot;
typedef struct { Run *run; bool cleanup, joined; } Work;
enum { SPAWN, STDOUT_BYTES, STDERR_BYTES, ROOT_EXIT, NATIVE_DONE, TERMINAL };
typedef struct {
    Run *run;
    int kind;
    DWORD length, code;
    unsigned char bytes[];
} Payload;

struct Context {
    volatile LONG refs, blocked;
    bool closing;
    Run *runs; /* environment-thread registry, not a global current-run slot */
};
struct Run {
    volatile LONG refs, pending, unavailable, callback_error, native_done, joined;
    volatile LONG root_exit, finalized;
    Context *context;
    Run *next;
    Snapshot snapshot;
    napi_env env;
    DWORD env_thread, root_code, launch_code;
    HANDLE thread, stop, capacity, job, root, root_thread, reader, writer, input;
    HANDLE stderr_reader, stderr_writer;
    bool closed, launched, launch_error, native_error, stdout_error, job_empty;
    bool stdout_eof, stderr_eof, cleanup_certain, killed, exit_sent;
    ULONGLONG cleanup_started;
    bool teardown, main_released, main_closing, tsfn_created;
    bool normal_queued, cleanup_queued, normal_complete, cleanup_complete;
    napi_async_work normal_work, cleanup_work;
    Work normal_arg, cleanup_arg;
    napi_async_cleanup_hook_handle hook;
    napi_threadsafe_function tsfn; /* immutable before worker publication */
    napi_deferred done_deferred;
    napi_ref done_ref;
};

static LONG read_atomic(volatile LONG *p) { return InterlockedCompareExchange(p, 0, 0); }
static void retain(Run *r) { InterlockedIncrement(&r->refs); }
static void context_retain(Context *c) { InterlockedIncrement(&c->refs); }
static void context_release(Context *c) { if (!InterlockedDecrement(&c->refs)) free(c); }
static void free_snapshot(Snapshot *s) {
    free(s->application); free(s->command); free(s->cwd); free(s->environment);
    memset(s, 0, sizeof(*s));
}
static bool close_owned(Run *r, HANDLE *h) {
    if (!*h) return true;
    if (*h == INVALID_HANDLE_VALUE) { *h = NULL; return true; }
    if (!CloseHandle(*h)) { r->closed = false; return false; }
    *h = NULL;
    return true;
}
static void release(Run *r, napi_env env) {
    if (InterlockedDecrement(&r->refs)) return;
    /* A failed lifetime proof retains memory/handles rather than freeing storage
     * that a native participant might still address. No payload diagnostics. */
    if (!r->closed || r->thread || r->stop || r->capacity || r->job || r->root || r->root_thread
        || r->reader || r->writer || r->input || r->stderr_reader || r->stderr_writer
        || r->hook || r->normal_work || r->cleanup_work || read_atomic(&r->pending)
        || (r->tsfn_created && !read_atomic(&r->finalized))) {
        InterlockedExchange(&r->context->blocked, 1); return;
    }
    if (r->done_ref) {
        if (!env || napi_delete_reference(env, r->done_ref) != napi_ok) {
            InterlockedExchange(&r->context->blocked, 1); return;
        }
    }
    Context *c = r->context;
    free_snapshot(&r->snapshot); free(r); context_release(c);
}
static void unavailable(Run *r) {
    InterlockedExchange(&r->unavailable, 1);
    InterlockedExchange(&r->context->blocked, 1);
    if (r->stop && !SetEvent(r->stop)) InterlockedExchange(&r->context->blocked, 1);
    if (r->capacity && !SetEvent(r->capacity)) InterlockedExchange(&r->context->blocked, 1);
}
static napi_value error(napi_env env, napi_status status, const char *code) {
    bool pending = false;
    if (status == napi_pending_exception) return NULL;
    if (napi_is_exception_pending(env, &pending) != napi_ok || pending) return NULL;
    if (napi_throw_error(env, code, "Program launch failed.") != napi_ok) return NULL;
    return NULL;
}

/* The JS adapter validates descriptor-only input and sends a detached binary
 * snapshot. Native validation repeats all bounds before publishing any worker.
 * One MiB is the explicit aggregate metadata allocation budget, not a per-argv
 * probe limit. The command line uses the actual Win32 32767-unit limit. */
typedef struct { const unsigned char *bytes; size_t length, offset; } Wire;
static bool word(Wire *w, uint32_t *value) {
    if (w->length - w->offset < 4) return false;
    memcpy(value, w->bytes + w->offset, 4); w->offset += 4; return true;
}
static wchar_t *wire_text(Wire *w) {
    uint32_t n;
    if (!word(w, &n) || n > SNAPSHOT_BYTES / 2 || (size_t)n * 2 > w->length - w->offset) return NULL;
    wchar_t *s = calloc((size_t)n + 1, sizeof(*s));
    if (!s) return NULL;
    memcpy(s, w->bytes + w->offset, (size_t)n * 2); w->offset += (size_t)n * 2;
    for (uint32_t i = 0; i < n; i++) if (!s[i]) { free(s); return NULL; }
    return s;
}
static bool local_drive(const wchar_t *s) {
    size_t n = wcslen(s);
    return n >= 3 && ((s[0] >= L'A' && s[0] <= L'Z') || (s[0] >= L'a' && s[0] <= L'z'))
        && s[1] == L':' && (s[2] == L'\\' || s[2] == L'/');
}
static void normalize(wchar_t *s) { for (; *s; s++) if (*s == L'/') *s = L'\\'; }
static bool append(wchar_t *command, size_t *used, wchar_t c) {
    if (*used >= COMMAND_UNITS - 1) return false;
    command[(*used)++] = c; command[*used] = 0; return true;
}
static bool slashes(wchar_t *command, size_t *used, size_t n) {
    while (n--) if (!append(command, used, L'\\')) return false;
    return true;
}
static bool quote(wchar_t *command, size_t *used, const wchar_t *arg) {
    if (!append(command, used, L'"')) return false;
    size_t backslashes = 0;
    for (;;) {
        wchar_t c = *arg++;
        if (c == L'\\') { backslashes++; continue; }
        if (!c) return slashes(command, used, backslashes * 2) && append(command, used, L'"');
        if (!slashes(command, used, c == L'"' ? backslashes * 2 + 1 : backslashes)
            || !append(command, used, c)) return false;
        backslashes = 0;
    }
}
typedef struct { wchar_t *key, *value; } Pair;
static bool compare_pairs(const Pair *a, const Pair *b, int *order) {
    int n = CompareStringOrdinal(a->key, -1, b->key, -1, TRUE);
    if (n == CSTR_EQUAL) n = CompareStringOrdinal(a->key, -1, b->key, -1, FALSE);
    if (!n) return false;
    *order = n - CSTR_EQUAL; return true;
}
static bool sort_pairs(Pair *pairs, uint32_t count) {
    if (count < 2) return true;
    Pair *temporary = calloc(count, sizeof(*temporary));
    if (!temporary) return false;
    bool ok = true;
    /* Checked bottom-up merge sort: bounded metadata cannot induce quadratic
     * sorting work, and Win32 comparison failure never masquerades as equality. */
    for (size_t width = 1; width < count; width *= 2) {
        for (size_t at = 0; at < count; at += width * 2) {
            size_t middle = at + width < count ? at + width : count;
            size_t end = at + width * 2 < count ? at + width * 2 : count;
            size_t left = at, right = middle, out = at;
            while (left < middle && right < end) {
                int order;
                if (!compare_pairs(&pairs[left], &pairs[right], &order)) { ok = false; goto finish; }
                temporary[out++] = order <= 0 ? pairs[left++] : pairs[right++];
            }
            while (left < middle) temporary[out++] = pairs[left++];
            while (right < end) temporary[out++] = pairs[right++];
        }
        memcpy(pairs, temporary, (size_t)count * sizeof(*pairs));
    }
finish:
    free(temporary); return ok;
}
static bool snapshot(const void *bytes, size_t length, Snapshot *out) {
    Wire w = {bytes, length, 0};
    uint32_t magic, count = 0, env_count = 0, has_cwd;
    wchar_t *original = NULL, *arg = NULL;
    Pair *pairs = NULL;
    bool ok = false;
    if (length > SNAPSHOT_BYTES || !word(&w, &magic) || magic != WIRE_MAGIC
        || !word(&w, &count) || !word(&w, &env_count) || !word(&w, &has_cwd)
        || has_cwd > 1 || count > length / 4 || env_count > length / 8) goto finish;
    original = wire_text(&w);
    if (!original || !local_drive(original)) goto finish;
    size_t n = wcslen(original) + 1;
    out->application = malloc(n * sizeof(wchar_t));
    if (!out->application) goto finish;
    memcpy(out->application, original, n * sizeof(wchar_t)); normalize(out->application);
    if (has_cwd) {
        out->cwd = wire_text(&w);
        if (!out->cwd || !local_drive(out->cwd)) goto finish;
        normalize(out->cwd);
    }
    out->command = calloc(COMMAND_UNITS, sizeof(wchar_t));
    if (!out->command) goto finish;
    size_t used = 0;
    if (!quote(out->command, &used, original)) goto finish;
    for (uint32_t i = 0; i < count; i++) {
        arg = wire_text(&w);
        if (!arg || !append(out->command, &used, L' ') || !quote(out->command, &used, arg)) goto finish;
        free(arg); arg = NULL;
    }
    pairs = calloc(env_count ? env_count : 1, sizeof(*pairs));
    if (!pairs) goto finish;
    for (uint32_t i = 0; i < env_count; i++) {
        pairs[i].key = wire_text(&w); pairs[i].value = wire_text(&w);
        if (!pairs[i].key || !pairs[i].value || !*pairs[i].key || wcschr(pairs[i].key, L'=')) goto finish;
    }
    if (w.offset != w.length || !sort_pairs(pairs, env_count)) goto finish;
    size_t units = 1, accepted = 0;
    for (uint32_t i = 0; i < env_count; i++) {
        int duplicate = i ? CompareStringOrdinal(pairs[i - 1].key, -1, pairs[i].key, -1, TRUE) : CSTR_LESS_THAN;
        if (!duplicate) goto finish;
        if (duplicate == CSTR_EQUAL) {
            if (wcscmp(pairs[i - 1].value, pairs[i].value)) goto finish;
            continue;
        }
        units += wcslen(pairs[i].key) + wcslen(pairs[i].value) + 2; accepted++;
        if (units > SNAPSHOT_BYTES / 2) goto finish;
    }
    if (!accepted) units = 2;
    out->environment = calloc(units, sizeof(wchar_t));
    if (!out->environment) goto finish;
    size_t at = 0;
    for (uint32_t i = 0; i < env_count; i++) {
        int duplicate = i ? CompareStringOrdinal(pairs[i - 1].key, -1, pairs[i].key, -1, TRUE) : CSTR_LESS_THAN;
        if (!duplicate) goto finish;
        if (duplicate == CSTR_EQUAL) continue;
        n = wcslen(pairs[i].key);
        memcpy(out->environment + at, pairs[i].key, n * 2); at += n;
        out->environment[at++] = L'=';
        n = wcslen(pairs[i].value);
        memcpy(out->environment + at, pairs[i].value, n * 2); at += n + 1;
    }
    ok = true;
finish:
    free(original); free(arg);
    if (pairs) {
        for (uint32_t i = 0; i < env_count; i++) { free(pairs[i].key); free(pairs[i].value); }
        free(pairs);
    }
    if (!ok) free_snapshot(out);
    return ok;
}

static Payload *payload(Run *r, int kind, DWORD length) {
    if (length > CHUNK_BYTES) return NULL;
    Payload *p = calloc(1, sizeof(*p) + length);
    if (!p) return NULL;
    p->run = r; p->kind = kind; p->length = length;
    retain(r); InterlockedIncrement(&r->pending); return p;
}
static void dispose(Payload *p, napi_env env) {
    Run *r = p->run;
    free(p); InterlockedDecrement(&r->pending); release(r, env);
}
/* Runs only on the coordinator, including while backpressured. A stop always
 * reaches the owned Job without depending on a JavaScript capacity callback. */
static bool observe_and_stop(Run *r) {
    if (r->root && !read_atomic(&r->root_exit)) {
        DWORD status = WaitForSingleObject(r->root, 0);
        if (status == WAIT_FAILED) return false;
        if (status == WAIT_OBJECT_0) {
            if (!GetExitCodeProcess(r->root, &r->root_code)) return false;
            InterlockedExchange(&r->root_exit, 1);
        }
    }
    DWORD stop = WaitForSingleObject(r->stop, 0);
    if (stop == WAIT_FAILED) return false;
    if (!r->killed && (stop == WAIT_OBJECT_0 || read_atomic(&r->root_exit) || !r->launched)) {
        r->cleanup_started = GetTickCount64();
        if (r->job && !TerminateJobObject(r->job, 1)) return false;
        r->killed = true;
    }
    return true;
}
static bool send_payload(Run *r, Payload *p, bool *closing) {
    for (;;) {
        if (*closing || read_atomic(&r->unavailable)) { dispose(p, NULL); return true; }
        napi_status s = napi_call_threadsafe_function(r->tsfn, p, napi_tsfn_nonblocking);
        if (s == napi_ok) return true;
        if (s == napi_closing) {
            /* Closing consumes this participant. Never call/release it again. */
            *closing = true; dispose(p, NULL); unavailable(r); return true;
        }
        if (s != napi_queue_full) { dispose(p, NULL); unavailable(r); return false; }
        if (!observe_and_stop(r)) { dispose(p, NULL); return false; }
        DWORD waited = WaitForSingleObject(r->capacity, 10);
        if (waited != WAIT_OBJECT_0 && waited != WAIT_TIMEOUT) { dispose(p, NULL); return false; }
        // Queue full is ordinary backpressure, never an output/protocol failure.
    }
}
static BOOL launch(Run *r, PROCESS_INFORMATION *pi) {
    STARTUPINFOEXW si; memset(&si, 0, sizeof(si)); memset(pi, 0, sizeof(*pi));
    HANDLE inherited[3] = {r->input, r->writer, r->stderr_writer};
    SIZE_T size = 0;
    BOOL first = InitializeProcThreadAttributeList(NULL, 2, 0, &size);
    if (first || GetLastError() != ERROR_INSUFFICIENT_BUFFER || !size) {
        r->launch_code = ERROR_INVALID_PARAMETER; return FALSE;
    }
    si.lpAttributeList = HeapAlloc(GetProcessHeap(), 0, size);
    if (!si.lpAttributeList) { r->launch_code = ERROR_NOT_ENOUGH_MEMORY; return FALSE; }
    BOOL initialized = InitializeProcThreadAttributeList(si.lpAttributeList, 2, 0, &size);
    BOOL ok = FALSE;
    if (!initialized || !UpdateProcThreadAttribute(si.lpAttributeList, 0,
            PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited, sizeof(inherited), NULL, NULL)
        || !UpdateProcThreadAttribute(si.lpAttributeList, 0,
            PROC_THREAD_ATTRIBUTE_JOB_LIST, &r->job, sizeof(r->job), NULL, NULL)) {
        r->launch_code = GetLastError(); goto finish;
    }
    si.StartupInfo.cb = sizeof(si); si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    si.StartupInfo.hStdInput = r->input; si.StartupInfo.hStdOutput = r->writer;
    si.StartupInfo.hStdError = r->stderr_writer;
    ok = CreateProcessW(r->snapshot.application, r->snapshot.command, NULL, NULL, TRUE,
        EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
        r->snapshot.environment, r->snapshot.cwd, &si.StartupInfo, pi);
    if (!ok) r->launch_code = GetLastError();
finish:
    if (initialized) DeleteProcThreadAttributeList(si.lpAttributeList);
    if (!HeapFree(GetProcessHeap(), 0, si.lpAttributeList)) r->closed = false;
    return ok;
}
static bool consume(Run *r, HANDLE reader, bool *eof, int kind, bool *closing, bool *progress) {
    DWORD available;
    if (!PeekNamedPipe(reader, NULL, 0, NULL, &available, NULL)) {
        if (GetLastError() == ERROR_BROKEN_PIPE) { *eof = true; *progress = true; return true; }
        if (kind == STDOUT_BYTES) r->stdout_error = true;
        return false;
    }
    if (!available) return true;
    *progress = true;
    DWORD count = available < CHUNK_BYTES ? available : CHUNK_BYTES;
    Payload *p = payload(r, kind, count);
    if (!p) return false;
    DWORD n;
    // Exactly one reader, and only already-available bytes: no pending blocking
    // I/O is closed by another thread. One pending chunk across both streams.
    if (!ReadFile(reader, p->bytes, count, &n, NULL) || !n) {
        if (kind == STDOUT_BYTES) r->stdout_error = true;
        dispose(p, NULL); return false;
    }
    p->length = n;
    if (read_atomic(&r->callback_error)) { dispose(p, NULL); return true; }
    return send_payload(r, p, closing);
}
static bool empty_job(Run *r) {
    if (!r->job) { r->job_empty = !r->launched; return r->job_empty; }
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting;
    if (!QueryInformationJobObject(r->job, JobObjectBasicAccountingInformation,
                                  &accounting, sizeof(accounting), NULL)) return false;
    r->job_empty = accounting.ActiveProcesses == 0; return true;
}
static DWORD WINAPI coordinator(void *data) {
    Run *r = data;
    bool closing = false;
    ULONGLONG idle_since = 0;
    PROCESS_INFORMATION pi;
    SECURITY_ATTRIBUTES sa = {sizeof(sa), NULL, TRUE};
    r->job = CreateJobObjectW(NULL, NULL);
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limit; memset(&limit, 0, sizeof(limit));
    limit.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!r->job || !SetInformationJobObject(r->job, JobObjectExtendedLimitInformation,
                                          &limit, sizeof(limit))) goto failed;
    r->input = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
                          &sa, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (r->input == INVALID_HANDLE_VALUE
        || !CreatePipe(&r->reader, &r->writer, &sa, CHUNK_BYTES)
        || !SetHandleInformation(r->reader, HANDLE_FLAG_INHERIT, 0)
        || !CreatePipe(&r->stderr_reader, &r->stderr_writer, &sa, CHUNK_BYTES)
        || !SetHandleInformation(r->stderr_reader, HANDLE_FLAG_INHERIT, 0)) goto failed;
    DWORD prelaunch_stop = WaitForSingleObject(r->stop, 0);
    if (prelaunch_stop != WAIT_TIMEOUT && prelaunch_stop != WAIT_OBJECT_0) goto failed;
    if (prelaunch_stop == WAIT_TIMEOUT) {
        if (!launch(r, &pi)) r->launch_error = true;
        else {
            r->launched = true; r->root = pi.hProcess; r->root_thread = pi.hThread;
            BOOL member = FALSE;
            bool thread_closed = close_owned(r, &r->root_thread);
            if (!thread_closed || !IsProcessInJob(r->root, r->job, &member) || !member) goto failed;
            Payload *p = payload(r, SPAWN, 0);
            if (!p || !send_payload(r, p, &closing)) goto failed;
        }
    }
    if (!close_owned(r, &r->writer) || !close_owned(r, &r->stderr_writer)) goto failed;
    for (;;) {
        if (!observe_and_stop(r)) goto failed;
        if (read_atomic(&r->root_exit) && !r->exit_sent) {
            Payload *p = payload(r, ROOT_EXIT, 0);
            if (!p) goto failed;
            p->code = r->root_code;
            if (!send_payload(r, p, &closing)) goto failed;
            r->exit_sent = true;
        }
        bool progress = false;
        if (!r->stdout_eof && !consume(r, r->reader, &r->stdout_eof, STDOUT_BYTES, &closing, &progress)) goto failed;
        if (!r->stderr_eof && !consume(r, r->stderr_reader, &r->stderr_eof, STDERR_BYTES, &closing, &progress)) goto failed;
        if (r->killed && !empty_job(r)) goto failed;
        if (r->job_empty && r->stdout_eof && r->stderr_eof
            && (!r->launched || read_atomic(&r->root_exit))) break;
        if (r->killed && (!r->job_empty || (r->launched && !read_atomic(&r->root_exit)))
            && GetTickCount64() - r->cleanup_started >= CLEANUP_MS) goto failed;
        // Do not charge slow JavaScript consumption against native cleanup.
        // Once the Job is empty, a quiet pipe whose writer was transferred to
        // an out-of-job program is bounded separately; moving bytes reset it.
        if (r->job_empty) {
            if (progress || !idle_since) idle_since = GetTickCount64();
            else if (GetTickCount64() - idle_since >= CLEANUP_MS) goto failed;
        }
        // An ordinary long-running program has no synthetic lifetime expiry.
        // Capacity is also signalled by cancellation and callback consumption.
        DWORD waited = WaitForSingleObject(r->capacity, 5);
        if (waited != WAIT_OBJECT_0 && waited != WAIT_TIMEOUT) goto failed;
    }
    goto finish;
failed:
    // Capture setup failure before cleanup changes LastError. A generic native
    // failure is not evidence of malformed stdout or failed stdout reading.
    if (!r->launched && !r->launch_error) {
        r->launch_code = GetLastError();
        r->launch_error = true;
    }
    r->native_error = true;
    if (r->job) {
        if (!TerminateJobObject(r->job, 1)) r->closed = false;
        ULONGLONG until = r->killed ? r->cleanup_started + CLEANUP_MS : GetTickCount64() + CLEANUP_MS;
        while (!r->job_empty && GetTickCount64() < until) {
            if (!empty_job(r)) break;
            if (!r->job_empty) Sleep(5);
        }
    } else r->job_empty = !r->launched;
    if (r->root && WaitForSingleObject(r->root, 0) == WAIT_OBJECT_0
        && GetExitCodeProcess(r->root, &r->root_code)) InterlockedExchange(&r->root_exit, 1);
finish:
    if (r->job_empty) close_owned(r, &r->job); else r->closed = false;
    if (!r->root || read_atomic(&r->root_exit)) close_owned(r, &r->root); else r->closed = false;
    close_owned(r, &r->root_thread);
    close_owned(r, &r->writer); close_owned(r, &r->stderr_writer);
    close_owned(r, &r->reader); close_owned(r, &r->stderr_reader); close_owned(r, &r->input);
    r->cleanup_certain = r->closed && r->job_empty && (!r->launched || read_atomic(&r->root_exit));
    if (!r->cleanup_certain) InterlockedExchange(&r->context->blocked, 1);
    InterlockedExchange(&r->native_done, 1);
    // FIFO NATIVE_DONE is delivered only after every accepted byte callback.
    // Work completion may then queue the sole terminal token without JS waits.
    if (!closing && !read_atomic(&r->unavailable)) {
        Payload *p = payload(r, NATIVE_DONE, 0);
        if (!p || !send_payload(r, p, &closing)) unavailable(r);
    }
    if (!closing && napi_release_threadsafe_function(r->tsfn, napi_tsfn_release) != napi_ok) unavailable(r);
    release(r, NULL); return 0;
}

static void join_execute(napi_env unused, void *data) {
    (void)unused; Work *w = data; Run *r = w->run;
    if (GetCurrentThreadId() == r->env_thread || !r->thread
        || WaitForSingleObject(r->thread, JOIN_MS) != WAIT_OBJECT_0) {
        unavailable(r); return;
    }
    w->joined = true; InterlockedExchange(&r->joined, 1);
}
static bool delete_work(napi_env env, Run *r, bool cleanup) {
    napi_async_work *slot = cleanup ? &r->cleanup_work : &r->normal_work;
    if (!*slot || napi_delete_async_work(env, *slot) != napi_ok) return false;
    *slot = NULL; release(r, env); return true;
}
static void release_main(Run *r, bool abort) {
    if (r->main_released || r->main_closing) return;
    r->main_released = true;
    if (napi_release_threadsafe_function(r->tsfn, abort ? napi_tsfn_abort : napi_tsfn_release) != napi_ok)
        unavailable(r);
}
static void work_complete(napi_env env, napi_status status, void *data) {
    Work *w = data; Run *r = w->run; retain(r);
    if (GetCurrentThreadId() != r->env_thread || status != napi_ok || !w->joined) {
        unavailable(r); goto finish;
    }
    if (w->cleanup) r->cleanup_complete = true; else r->normal_complete = true;
    if (!delete_work(env, r, w->cleanup)) { unavailable(r); goto finish; }
    if ((r->normal_queued && !r->normal_complete) || (r->cleanup_queued && !r->cleanup_complete)) goto finish;
    // Joining, not TSFN finalization or a cleanup flag, permits handle closure.
    if (!close_owned(r, &r->thread) || !close_owned(r, &r->stop) || !close_owned(r, &r->capacity)) {
        unavailable(r); goto finish;
    }
    if (r->normal_work && !delete_work(env, r, false)) { unavailable(r); goto finish; }
    if (r->cleanup_work && !delete_work(env, r, true)) { unavailable(r); goto finish; }
    if (!r->hook || napi_remove_async_cleanup_hook(r->hook) != napi_ok) { unavailable(r); goto finish; }
    r->hook = NULL; release(r, env);
    if (r->teardown) goto finish; /* no JavaScript calls during cleanup completion */
    if (r->main_released || r->main_closing) { unavailable(r); goto finish; }
    Payload *p = payload(r, TERMINAL, 0);
    if (!p) { unavailable(r); release_main(r, false); goto finish; }
    napi_status sent = napi_call_threadsafe_function(r->tsfn, p, napi_tsfn_nonblocking);
    if (sent != napi_ok) {
        dispose(p, env);
        if (sent == napi_closing) r->main_closing = true;
        unavailable(r);
    }
    release_main(r, false);
finish:
    release(r, env);
}
static void queue_normal(Run *r) {
    if (r->normal_queued || r->teardown || !read_atomic(&r->native_done)) return;
    r->normal_queued = true;
    if (napi_queue_async_work(r->env, r->normal_work) != napi_ok) unavailable(r);
}
static void cleanup_hook(napi_async_cleanup_hook_handle handle, void *data) {
    Run *r = data;
    if (GetCurrentThreadId() != r->env_thread || handle != r->hook || r->cleanup_queued) {
        unavailable(r); return;
    }
    r->teardown = true; unavailable(r); r->cleanup_queued = true;
    release_main(r, true);
    // Pre-created, but queued only from the hook: prequeueing a hook-waiting
    // worker deadlocks Node's outstanding-work drain before hook dispatch.
    if (napi_queue_async_work(r->env, r->cleanup_work) != napi_ok) unavailable(r);
}
static napi_status bool_field(napi_env env, napi_value o, const char *name, bool b) {
    napi_value value; napi_status s = napi_get_boolean(env, b, &value);
    return s == napi_ok ? napi_set_named_property(env, o, name, value) : s;
}
static napi_status uint_field(napi_env env, napi_value o, const char *name, DWORD n) {
    napi_value value; napi_status s = napi_create_uint32(env, n, &value);
    return s == napi_ok ? napi_set_named_property(env, o, name, value) : s;
}
static void remove_registry(Run *r, napi_env env) {
    Run **slot = &r->context->runs;
    while (*slot && *slot != r) slot = &(*slot)->next;
    if (*slot) { *slot = r->next; r->next = NULL; release(r, env); }
}
static void terminal(napi_env env, Run *r) {
    if (read_atomic(&r->unavailable) || !read_atomic(&r->joined) || !read_atomic(&r->native_done)
        || read_atomic(&r->pending) || !r->done_deferred) { unavailable(r); return; }
    napi_value object;
    napi_status s = napi_create_object(env, &object);
    if (s == napi_ok) s = bool_field(env, object, "rootExit", read_atomic(&r->root_exit) != 0);
    if (s == napi_ok) s = uint_field(env, object, "rootCode", r->root_code);
    if (s == napi_ok) s = bool_field(env, object, "launchError", r->launch_error);
    if (s == napi_ok) s = uint_field(env, object, "launchCode", r->launch_code);
    if (s == napi_ok) s = bool_field(env, object, "callbackError", read_atomic(&r->callback_error) != 0);
    if (s == napi_ok) s = bool_field(env, object, "nativeError", r->native_error);
    if (s == napi_ok) s = bool_field(env, object, "stdoutError", r->stdout_error);
    if (s == napi_ok) s = bool_field(env, object, "cleanupCertain", r->cleanup_certain);
    if (s != napi_ok) { unavailable(r); return; }
    // Node-API status, not a non-null env, is the JS-availability proof.
    // A deferred is single-attempt: never retry after a non-ok resolution.
    napi_deferred once = r->done_deferred; r->done_deferred = NULL;
    if (napi_resolve_deferred(env, once, object) != napi_ok) { unavailable(r); return; }
    if (r->cleanup_certain) remove_registry(r, env);
}
static void call_js(napi_env env, napi_value callback, void *context, void *data) {
    Run *r = context; Payload *p = data;
    if (!p) return;
    retain(r); int kind = p->kind;
    if (!env || !callback) { unavailable(r); dispose(p, env); release(r, env); return; }
    if (!read_atomic(&r->unavailable) && !read_atomic(&r->callback_error) && kind <= ROOT_EXIT) {
        napi_value values[2], receiver, ignored;
        bool called = false;
        napi_status s = napi_create_int32(env, kind, &values[0]);
        if (s == napi_ok && (kind == STDOUT_BYTES || kind == STDERR_BYTES))
            s = napi_create_buffer_copy(env, p->length, p->bytes, NULL, &values[1]);
        else if (s == napi_ok && kind == ROOT_EXIT) s = napi_create_uint32(env, p->code, &values[1]);
        else if (s == napi_ok) s = napi_get_undefined(env, &values[1]);
        if (s == napi_ok) s = napi_get_undefined(env, &receiver);
        if (s == napi_ok) { called = true; s = napi_call_function(env, receiver, callback, 2, values, &ignored); }
        if (s != napi_ok) {
            bool pending = false; napi_value discarded = NULL;
            napi_status checked = napi_is_exception_pending(env, &pending);
            if (called && s == napi_pending_exception && checked == napi_ok && pending
                && napi_get_and_clear_last_exception(env, &discarded) == napi_ok && discarded) {
                InterlockedExchange(&r->callback_error, 1);
                if (r->stop && !SetEvent(r->stop)) unavailable(r);
            } else unavailable(r);
        }
    }
    dispose(p, env);
    if (r->capacity && !SetEvent(r->capacity)) unavailable(r);
    if (kind == NATIVE_DONE) queue_normal(r);
    if (kind == TERMINAL) terminal(env, r);
    release(r, env);
}
static void tsfn_finalize(napi_env env, void *data, void *unused) {
    (void)unused; Run *r = data;
    InterlockedExchange(&r->finalized, 1); /* never overwrite the shared API handle */
    release(r, env);
}
static void handle_finalize(napi_env env, void *data, void *unused) { (void)unused; release(data, env); }
static napi_value stop(napi_env env, napi_callback_info info) {
    size_t argc = 1; napi_value unused; void *data = NULL;
    napi_status s = napi_get_cb_info(env, info, &argc, &unused, NULL, &data);
    if (s != napi_ok || argc || !data) return error(env, s, "ERR_TRANSPORT_STATE");
    Run *r = data;
    if (!read_atomic(&r->joined)) {
        if (r->stop && !SetEvent(r->stop)) unavailable(r);
        if (r->capacity && !SetEvent(r->capacity)) unavailable(r);
    }
    napi_value promise; s = napi_get_reference_value(env, r->done_ref, &promise);
    return s == napi_ok ? promise : error(env, s, "ERR_TRANSPORT_STATE");
}
static void instance_finalize(napi_env env, void *data, void *unused) {
    (void)unused; Context *c = data;
    c->closing = true; InterlockedExchange(&c->blocked, 1);
    while (c->runs) { Run *r = c->runs; c->runs = r->next; r->next = NULL; release(r, env); }
    context_release(c);
}
static void rollback(napi_env env, Run *r) {
    retain(r); /* only worker-not-started paths */
    if (r->hook) {
        if (napi_remove_async_cleanup_hook(r->hook) == napi_ok) { r->hook = NULL; release(r, env); }
        else unavailable(r);
    }
    if (r->normal_work && !delete_work(env, r, false)) unavailable(r);
    if (r->cleanup_work && !delete_work(env, r, true)) unavailable(r);
    bool a = close_owned(r, &r->stop), b = close_owned(r, &r->capacity);
    if (!a || !b) unavailable(r);
    if (r->tsfn_created) release_main(r, true);
    release(r, env);
}
static napi_value start(napi_env env, napi_callback_info info) {
    size_t argc = 3; napi_value args[3]; void *data = NULL;
    napi_status s = napi_get_cb_info(env, info, &argc, args, NULL, NULL);
    if (s != napi_ok || argc != 2) return error(env, s, "EINVAL");
    s = napi_get_instance_data(env, &data);
    if (s != napi_ok || !data) return error(env, s, "ERR_TRANSPORT_STATE");
    Context *c = data;
    if (c->closing || read_atomic(&c->blocked)) return error(env, napi_ok, "ERR_TRANSPORT_CLEANUP");
    bool is_buffer = false; napi_valuetype type;
    s = napi_is_buffer(env, args[0], &is_buffer);
    if (s == napi_ok) s = napi_typeof(env, args[1], &type);
    if (s != napi_ok || !is_buffer || type != napi_function) return error(env, s, "EINVAL");
    void *bytes; size_t length;
    s = napi_get_buffer_info(env, args[0], &bytes, &length);
    if (s != napi_ok) return error(env, s, "EINVAL");
    Run *r = calloc(1, sizeof(*r));
    if (!r) return error(env, napi_ok, "EAGAIN");
    if (!snapshot(bytes, length, &r->snapshot)) { free(r); return error(env, napi_ok, "EINVAL"); }
    r->refs = 1; r->context = c; context_retain(c); r->closed = true;
    r->env = env; r->env_thread = GetCurrentThreadId();
    r->normal_arg.run = r; r->cleanup_arg.run = r; r->cleanup_arg.cleanup = true;
    napi_value object, done, stop_fn, external, name;
    s = napi_create_object(env, &object);
    if (s == napi_ok) s = napi_create_promise(env, &r->done_deferred, &done);
    if (s == napi_ok) s = napi_create_reference(env, done, 1, &r->done_ref);
    if (s == napi_ok) s = napi_create_function(env, "stop", NAPI_AUTO_LENGTH, stop, r, &stop_fn);
    if (s == napi_ok) {
        retain(r); s = napi_create_external(env, r, handle_finalize, NULL, &external);
        if (s != napi_ok) release(r, env);
    }
    if (s == napi_ok) {
        napi_property_descriptor d = {"_runLifetime", NULL, NULL, NULL, NULL, external, napi_default, NULL};
        s = napi_define_properties(env, stop_fn, 1, &d);
    }
    if (s == napi_ok) s = napi_set_named_property(env, object, "stop", stop_fn);
    if (s == napi_ok) s = napi_set_named_property(env, object, "done", done);
    if (s == napi_ok) s = napi_create_string_utf8(env, "windows-process-transport", NAPI_AUTO_LENGTH, &name);
    if (s == napi_ok) {
        s = napi_create_async_work(env, NULL, name, join_execute, work_complete, &r->cleanup_arg, &r->cleanup_work);
        if (s == napi_ok) retain(r);
    }
    if (s == napi_ok) {
        s = napi_create_async_work(env, NULL, name, join_execute, work_complete, &r->normal_arg, &r->normal_work);
        if (s == napi_ok) retain(r);
    }
    if (s == napi_ok) {
        s = napi_add_async_cleanup_hook(env, cleanup_hook, r, &r->hook);
        if (s == napi_ok) retain(r);
    }
    if (s == napi_ok) {
        napi_threadsafe_function created;
        s = napi_create_threadsafe_function(env, args[1], NULL, name, QUEUE_ITEMS, 1, r,
                                            tsfn_finalize, r, call_js, &created);
        if (s == napi_ok) { r->tsfn = created; r->tsfn_created = true; retain(r); }
    }
    if (s != napi_ok) { rollback(env, r); release(r, env); return error(env, s, "ERR_TRANSPORT_STATE"); }
    r->stop = CreateEventW(NULL, TRUE, FALSE, NULL);
    r->capacity = CreateEventW(NULL, FALSE, FALSE, NULL);
    if (!r->stop || !r->capacity) {
        rollback(env, r); release(r, env); return error(env, napi_ok, "EAGAIN");
    }
    s = napi_acquire_threadsafe_function(r->tsfn);
    if (s != napi_ok) { rollback(env, r); release(r, env); return error(env, s, "ERR_TRANSPORT_STATE"); }
    retain(r); /* coordinator */
    r->next = c->runs; c->runs = r; /* initial reference transfers to registry */
    r->thread = CreateThread(NULL, 0, coordinator, r, 0, NULL);
    if (!r->thread) {
        remove_registry(r, env);
        if (napi_release_threadsafe_function(r->tsfn, napi_tsfn_release) != napi_ok) unavailable(r);
        rollback(env, r); release(r, env);
        return error(env, napi_ok, "EAGAIN");
    }
    return object; /* no fallible JS allocation after worker publication */
}
NAPI_MODULE_INIT() {
    Context *c = calloc(1, sizeof(*c));
    if (!c) return error(env, napi_ok, "EAGAIN");
    c->refs = 1;
    napi_status s = napi_set_instance_data(env, c, instance_finalize, NULL);
    if (s != napi_ok) { free(c); return error(env, s, "ERR_TRANSPORT_STATE"); }
    napi_value function;
    s = napi_create_function(env, "start", NAPI_AUTO_LENGTH, start, NULL, &function);
    if (s == napi_ok) s = napi_set_named_property(env, exports, "start", function);
    return s == napi_ok ? exports : error(env, s, "ERR_TRANSPORT_STATE");
}
