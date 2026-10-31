import { Buffer } from 'node:buffer';
import { createLaunchArtwork } from '../src/core/launch-artwork.mjs';
import { createTimerArtwork } from '../src/core/timer-artwork.mjs';
import { createOnceArtwork } from '../src/core/once-artwork.mjs';
import { renderRecord } from './preview-rendering.mjs';

const nativeSvg = uri => Buffer.from(decodeURIComponent(uri.slice('data:image/svg+xml,'.length)));

function network() {
  const values = [8, 9, 8, 11, 10, 12, 11, 13, 12, 15, 13, 14];
  const points = values.map((value, index) => `${16 + index * 112 / (values.length - 1)},${128 - value / 20 * 38}`);
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
    <rect width="144" height="144" fill="#000"/>
    <g font-family="sans-serif" text-anchor="middle"><text x="72" y="29" font-size="15" fill="#a2afb9">Network</text><text x="72" y="70" font-size="26" fill="#edf2f5">14 MB/s</text></g>
    <path d="M16 128H128" stroke="#25313a"/>
    <polyline points="${points.join(' ')}" fill="none" stroke="#69bbca" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
  </svg>`);
}

function latency() {
  const values = [41, 40, 42, 43, 41, 40, 42, 44, 43, 42, 41, 42];
  const points = values.map((value, index) => `${16 + index * 112 / (values.length - 1)},${128 - value / 100 * 24}`);
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
    <rect width="144" height="144" fill="#000"/>
    <g font-family="sans-serif" text-anchor="middle"><text x="72" y="28" font-size="14" fill="#a2afb9">p95 latency</text><text x="72" y="78" font-size="40" fill="#edf2f5">42</text><text x="72" y="102" font-size="17" fill="#a2afb9">ms</text></g>
    <polyline points="${points.join(' ')}" fill="none" stroke="#69bbca" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
  </svg>`);
}

function battery() {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
    <rect width="144" height="144" fill="#000"/>
    <g font-family="sans-serif" text-anchor="middle"><text x="72" y="28" font-size="15" fill="#a2afb9">Battery</text><text x="72" y="79" font-size="40" fill="#edf2f5">81%</text><text x="72" y="105" font-size="17" fill="#a2afb9">Charging</text></g>
    <rect x="18" y="122" width="108" height="6" rx="2" fill="#25313a"/><rect x="18" y="122" width="${108 * .81}" height="6" rx="2" fill="#69bbca"/>
  </svg>`);
}

/** Raw artwork only: the device compositor applies display simulation once. */
export function createSlideKeyArtwork() {
  return {
    cpu: renderRecord('text:37%|font-size:42;label:CPU;label-size:16;color:#edf2f5;label-color:#a2afb9'),
    memory: renderRecord('progress:62|label:Memory;color:#69bbca;value-size:30;label-size:15;thickness:9'),
    network: network(),
    build: renderRecord('progress:72|type:bar;label:Build;color:#a78bfa;thickness:16;value-size:30;label-size:17;value-position:above'),
    stream: nativeSvg(createLaunchArtwork('ready', 'monitor', '#22d3ee', 'ready', '.py')),
    loop: nativeSvg(createTimerArtwork('ready', 'backup', '#a78bfa', 'ready', '.py')),
    run: nativeSvg(createOnceArtwork('ready', 'build', '#ffb454', 'ready', '.py')),
    ssd: renderRecord('progress:128/512|type:bar;display:128 GB;label:SSD free;color:#69bbca;thickness:12;value-size:26;label-size:16;value-position:above'),
    gpu: renderRecord('text:64°C|font-size:36;label:GPU;label-size:16;color:#edf2f5;label-color:#a2afb9'),
    battery: battery(),
    api: renderRecord('card:UP|header:API;footer:HTTP 200;font-size:44;color:#79d5a2;header-size:14;footer-size:17;header-color:#a2afb9;footer-color:#79d5a2'),
    latency: latency(),
    tls: renderRecord('card:18|header:TLS expiry;footer:days;font-size:44;color:#efb566;header-size:14;footer-size:17;header-color:#a2afb9;footer-color:#efb566'),
    http: renderRecord('text:0.2%|font-size:37;label:HTTP 5xx;label-size:16;color:#edf2f5;label-color:#a2afb9'),
    backup: renderRecord('card:12|header:Backup age;footer:min;font-size:44;color:#edf2f5;header-size:14;footer-size:17;header-color:#a2afb9;footer-color:#a2afb9'),
    queue: renderRecord('card:7|header:Job queue;footer:waiting;font-size:44;color:#edf2f5;header-size:14;footer-size:17;header-color:#a2afb9;footer-color:#a2afb9'),
    tests: renderRecord('card:142/144|header:Last tests;footer:2 failed;font-size:27;color:#efb566;header-size:14;footer-size:17;header-color:#a2afb9;footer-color:#efb566'),
    coverage: renderRecord('progress:86.4|display:86.4%;label:Coverage;color:#69bbca;value-size:18;label-size:15;thickness:7'),
    duration: renderRecord('card:2m 14s|header:Last duration;font-size:30;color:#edf2f5;header-size:14;footer-size:17;header-color:#a2afb9;footer-color:#a2afb9'),
    lint: renderRecord('card:0|header:Lint;footer:warnings;font-size:44;color:#79d5a2;header-size:14;footer-size:17;header-color:#a2afb9;footer-color:#79d5a2'),
    scan: renderRecord('card:0|header:Scan;footer:critical;font-size:44;color:#79d5a2;header-size:14;footer-size:17;header-color:#a2afb9;footer-color:#79d5a2'),
    commit: renderRecord('card:7c91e2a|header:Commit;font-size:25;color:#edf2f5;header-size:14;footer-size:17;header-color:#a2afb9;footer-color:#a2afb9'),
    artifacts: renderRecord('card:3 files|header:Artifacts;footer:42 MB;font-size:32;color:#edf2f5;header-size:14;footer-size:17;header-color:#a2afb9;footer-color:#a2afb9'),
    deploy: renderRecord('card:Blocked|header:Deploy;font-size:28;color:#efb566;header-size:14;footer-size:17;header-color:#a2afb9;footer-color:#efb566'),
    sync: renderRecord('card:23|header:Sync;footer:files pending;font-size:44;color:#edf2f5;header-size:14;footer-size:17;header-color:#a2afb9;footer-color:#a2afb9'),
    exit: renderRecord('card:1|header:Last exit;font-size:44;color:#efb566;header-size:14;footer-size:17;header-color:#a2afb9;footer-color:#efb566'),
  };
}
