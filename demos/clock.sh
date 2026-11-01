#!/bin/sh
# Stream clock: tap the key to start or stop.
exec /usr/bin/osascript -l JavaScript <<'JXA'
ObjC.import('Foundation');

const locale = $.NSLocale.currentLocale;
const pattern = ObjC.unwrap($.NSDateFormatter.dateFormatFromTemplateOptionsLocale('yMd', 0, locale))
    .replace(/'[^']*(?:''[^']*)*'/g, '');
const dayFirst = pattern.indexOf('d') < pattern.indexOf('M');

function formatter(locale, pattern) {
    const result = $.NSDateFormatter.alloc.init;
    result.locale = locale;
    result.calendar = $.NSCalendar.alloc.initWithCalendarIdentifier($.NSCalendarIdentifierGregorian);
    result.dateFormat = pattern;
    return result;
}

const invariant = $.NSLocale.localeWithLocaleIdentifier('en_US_POSIX');
const date = formatter(invariant, dayFirst ? "dd'/'MM'/'yyyy" : "MM'/'dd'/'yyyy");
const time = formatter(invariant, "HH':'mm':'ss");
const weekday = formatter(locale, 'EEEE');
const stdout = $.NSFileHandle.fileHandleWithStandardOutput;

function escapeField(value) {
    return value.replace(/[\\|;]/g, '\\$&');
}

function footerSize(value) {
    // Match the renderer's normal sans estimates; UTF-16 counting is conservative
    // for combining characters and surrogate pairs, without a grapheme framework.
    let width = 0;
    for (let i = 0; i < value.length; i++) {
        const character = value.charAt(i);
        let units = 0.56;
        if (value.charCodeAt(i) > 0xff) units = 1.2;
        else if (/\s/.test(character)) units = 0.28;
        else if (/[ilI.,'`!:;|]/.test(character)) units = 0.25;
        else if (/[frt]/.test(character)) units = 0.33;
        else if (/[mwMW@%&]/.test(character)) units = 1;
        else if (/[A-Z]/.test(character)) units = 0.7;
        width += units * 1.04;
    }
    return width === 0 ? 20 : Math.min(20, Math.floor(112 / width * 100) / 100);
}

let colonVisible = true;
while (true) {
    const now = $.NSDate.date;
    const clock = ObjC.unwrap(time.stringFromDate(now));
    const main = clock.slice(0, 5).replace(':', colonVisible ? ':' : ' ');
    const header = ObjC.unwrap(date.stringFromDate(now));
    const footer = ObjC.unwrap(weekday.stringFromDate(now)).normalize('NFC').replace(/\s+/g, ' ').trim();
    const record = 'card:' + escapeField(main) + '|header:' + escapeField(header)
        + ';footer:' + escapeField(footer) + ';font:mono;font-size:36;padding-x:0;header-font:sans;footer-font:sans'
        + ';header-size:18;footer-size:' + footerSize(footer) + '\n';
    stdout.writeData($(record).dataUsingEncoding($.NSUTF8StringEncoding));
    colonVisible = !colonVisible;
    $.NSThread.sleepForTimeInterval(0.5);
}
JXA
