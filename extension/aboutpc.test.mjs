// Run: node extension/aboutpc.test.mjs
import assert from 'node:assert/strict';
import {
    parseCpuStat, cpuUsage, parseSensors, parseCpuModel, parseMemTotal,
    parseOsRelease, formatModel, parseLspciGpu, parseCoreStats, parseMemInfo, parseNetDev,
    formatRate, formatBytes,
} from './sysinfo.js';

const a = parseCpuStat('cpu  100 0 100 700 100 0 0 0 0 0\ncpu0 1 2 3');
const b = parseCpuStat('cpu  200 0 100 750 150 0 0 0 0 0\n');
assert.deepEqual(a, {total: 1000, idle: 800});
assert.equal(cpuUsage(a, b), 50); // 100 busy of 200 jiffies
assert.equal(cpuUsage(a, a), 0);
assert.equal(parseCpuStat(''), null);

assert.deepEqual(parseSensors([['Package id 0\n', '47000\n'], ['Core 0\n', '46499'], [null, '45000'], ['Core 2', null]]),
    [['Core 0', '46°'], ['Sensor 3', '45°'], ['Package id 0', '47°']]);

assert.equal(parseCpuModel('processor\t: 0\nmodel name\t: Intel(R) Core(TM)  i5-6300U CPU @ 2.40GHz\n'),
    'Intel(R) Core(TM) i5-6300U CPU @ 2.40GHz');
assert.equal(parseMemTotal('MemTotal:        7654321 kB\nMemFree: 1 kB'), '7.3 GB');
assert.equal(parseOsRelease('NAME="Ubuntu"\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\n'), 'Ubuntu 24.04.1 LTS');
assert.equal(formatModel('HP\n', 'HP EliteBook 840 G3\n'), 'HP EliteBook 840 G3');
assert.equal(formatModel('LENOVO', 'ThinkPad X1'), 'LENOVO ThinkPad X1');
assert.equal(parseLspciGpu('00:00.0 "Host bridge" "Intel Corporation" "Xeon"\n' +
    '00:02.0 "VGA compatible controller" "Intel Corporation" "Skylake GT2 [HD Graphics 520]" -r07 "HP" "x"\n' +
    '01:00.0 "3D controller" "Advanced Micro Devices, Inc. [AMD/ATI]" "Navi 23"\n'),
'Intel HD Graphics 520\nAMD/ATI Navi 23');
assert.equal(parseLspciGpu(''), null);

assert.deepEqual(parseCoreStats('cpu  9 9 9 9\ncpu0 1 0 1 8\ncpu1 2 0 2 6\nintr 5'),
    [{total: 10, idle: 8}, {total: 10, idle: 6}]);
assert.deepEqual(parseMemInfo('MemTotal: 4 kB\nMemAvailable: 1 kB\nSwapTotal: 2 kB\nSwapFree: 2 kB\n'),
    {total: 4096, avail: 1024, swapTotal: 2048, swapFree: 2048});
assert.equal(parseMemInfo(''), null);
assert.deepEqual(parseNetDev('h1\nh2\n    lo: 50 0 0 0 0 0 0 0 60\n  eth0: 100 0 0 0 0 0 0 0 7 0\n'), {rx: 100, tx: 7});
assert.equal(formatRate(0), '0B/s');
assert.equal(formatRate(1536), '1.5KB/s');
assert.equal(formatBytes(8 * 1024 ** 3), '8.0 GB');
console.log('aboutpc ok');
