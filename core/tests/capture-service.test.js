const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

// 测试在构建后运行（pnpm test = pnpm build:ts && node --test），依赖 dist 产物
const captureRoot = path.join(__dirname, '../dist/capture');
const { parseHttpHead, extractLoginInfo, matchesHostPattern, isCaptureHost } = require(path.join(captureRoot, 'code-extractor'));
const { WsFrameParser, parseFrameHeader, unmask } = require(path.join(captureRoot, 'ws-parser'));
const { loadConfig, normalizeConfig, parsePortRange, pickRandomProxyPort, splitList } = require(path.join(captureRoot, 'config'));
const { createSessionStore } = require(path.join(captureRoot, 'session-store'));
const { parseConnectLine, parseAbsoluteUrl, findHeadEnd } = require(path.join(captureRoot, 'mitm-proxy'));
const { resolveAdvertiseAddresses, classifyIpv4, ipv4ToInt } = require(path.join(captureRoot, 'ip-utils'));
const { loadOrCreateRootCa, getCaCertDer, getSecureContextForHost } = require(path.join(captureRoot, 'ca'));

const GATEWAY_HOST = 'gate-obt.nqf.qq.com';

function buildHead(target, extra = '') {
    return Buffer.from([
        `GET ${target} HTTP/1.1`,
        'Host: gate-obt.nqf.qq.com',
        'Connection: Upgrade',
        'Upgrade: websocket',
        ...(extra ? [extra] : []),
        '',
        '',
    ].join('\r\n'), 'latin1');
}

test('code-extractor: 从网关 WebSocket 升级请求提取 code/openID/版本', () => {
    const head = buildHead('/prod/ws?platform=qq&code=ABCDEF0123456789&openID=openid-1&ver=1.17.0.3_20261117');
    const parsed = parseHttpHead(head);
    assert.equal(parsed.method, 'GET');
    assert.equal(parsed.isUpgrade, true);

    const info = extractLoginInfo({
        host: GATEWAY_HOST,
        parsedHead: parsed,
        config: { captureHosts: ['*.nqf.qq.com'] },
    });
    assert.equal(info.code, 'ABCDEF0123456789');
    assert.equal(info.openId, 'openid-1');
    assert.equal(info.clientVersion, '1.17.0.3_20261117');
    assert.equal(info.matched, true);
});

test('code-extractor: 非网关域名短 code 视为噪声（非升级请求）', () => {
    const head = Buffer.from([
        'GET /api?code=short123&openID=openid-2 HTTP/1.1',
        'Host: q.qq.com',
        '',
        '',
    ].join('\r\n'), 'latin1');
    const info = extractLoginInfo({
        host: 'q.qq.com',
        parsedHead: parseHttpHead(head),
        config: { captureHosts: ['*.qq.com'] },
    });
    assert.equal(info.code, '');
    assert.equal(info.openId, 'openid-2');
});

test('code-extractor: 通配域名匹配裸域与子域', () => {
    assert.equal(matchesHostPattern('nqf.qq.com', '*.nqf.qq.com'), true);
    assert.equal(matchesHostPattern('a.b.nqf.qq.com', '*.nqf.qq.com'), true);
    assert.equal(matchesHostPattern('evil.com', '*.nqf.qq.com'), false);
    assert.equal(isCaptureHost('q.qq.com', { captureHosts: ['q.qq.com', '*.qq.com'] }), true);
});

test('ws-parser: 解析掩码二进制帧与分片消息', () => {
    const mask = Buffer.from([1, 2, 3, 4]);
    const payload = Buffer.from([9, 8, 7, 6, 5, 4]);
    const masked = unmask(payload, mask);
    const frame = Buffer.concat([
        Buffer.from([0x82, 0x80 | payload.length]),
        mask,
        masked,
    ]);
    const header = parseFrameHeader(frame);
    assert.equal(header.opcode, 0x2);
    assert.equal(header.masked, true);
    assert.equal(header.length, payload.length);

    const received = [];
    const parser = new WsFrameParser({ onMessage: msg => received.push(msg) });
    parser.push(frame.subarray(0, 3));
    parser.push(frame.subarray(3));
    assert.equal(received.length, 1);
    assert.deepEqual([...received[0]], [...payload]);
});

test('ws-parser: 分片（FIN=0 + 续帧）合并为完整消息', () => {
    const part1 = Buffer.from([0x02, 0x03, 1, 2, 3]);
    const part2 = Buffer.from([0x80, 0x02, 4, 5]);
    const received = [];
    const parser = new WsFrameParser({ onMessage: msg => received.push(msg) });
    parser.push(part1);
    assert.equal(received.length, 0);
    parser.push(part2);
    assert.equal(received.length, 1);
    assert.deepEqual([...received[0]], [1, 2, 3, 4, 5]);
});

test('config: 环境变量覆盖与随机端口', () => {
    assert.deepEqual(splitList('a, b,,c'), ['a', 'b', 'c']);
    assert.deepEqual(parsePortRange('18000', 0, 0), { from: 18000, to: 18000 });
    assert.deepEqual(parsePortRange('2000-9999', 0, 0), { from: 2000, to: 2000 });
    assert.deepEqual(parsePortRange('bad', 1234, 1234), { from: 1234, to: 1234 });
    const port = pickRandomProxyPort();
    assert.ok(port >= 2000 && port <= 9999);

    const normalized = normalizeConfig({ captureHosts: '*.qq.com', apiToken: ' t ' });
    assert.deepEqual(normalized.captureHosts, ['*.qq.com']);
    assert.equal(normalized.apiToken, 't');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-config-'));
    const previous = { ...process.env };
    try {
        process.env.CAPTURE_PORTS = '18080';
        const { config, configPath } = loadConfig({ dataDir: dir });
        assert.equal(config.proxyPortFrom, 18080);
        assert.equal(config.proxyPortAuto, undefined);
        assert.ok(fs.existsSync(configPath));
    } finally {
        process.env = previous;
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('config: 未配置端口时每次启动随机（2000-9999）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-config-'));
    const previous = { ...process.env };
    try {
        delete process.env.CAPTURE_PORTS;
        const { config } = loadConfig({ dataDir: dir });
        assert.equal(config.proxyPortAuto, true);
        assert.ok(config.proxyPortFrom >= 2000 && config.proxyPortFrom <= 9999);
    } finally {
        process.env = previous;
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('session-store: code/好友记录与会话快照', () => {
    const store = createSessionStore({ config: { sessionTtlMs: 60_000, autoStopSec: 900 } });
    const session = store.createSession('s1', 'qq');
    assert.equal(store.addCode(session, { code: 'C1', openId: 'O1', clientVersion: '1.0.0.0_20260101' }), true);
    assert.equal(store.addFriendGids(session, { gids: [3, 1, 2, 1], source: 'gamepb.friendpb.FriendService.GetAll', complete: true }), true);
    const snapshot = store.buildSnapshot(session);
    assert.equal(snapshot.captured, true);
    assert.equal(snapshot.friends.complete, true);
    assert.deepEqual(snapshot.friends.items.map(item => item.gid), ['1', '2', '3']);
    assert.equal(snapshot.channels.qq.status, 'captured');
    assert.equal(store.listSessions().includes('s1'), true);

    store.deleteSession('s1');
    assert.equal(store.getSession('s1'), null);
});

test('mitm-proxy: CONNECT 行与绝对 URL 解析', () => {
    assert.deepEqual(parseConnectLine('CONNECT gate-obt.nqf.qq.com:443 HTTP/1.1'), { host: 'gate-obt.nqf.qq.com', port: 443 });
    assert.deepEqual(parseConnectLine('CONNECT [::1]:8443 HTTP/1.1'), { host: '::1', port: 8443 });
    assert.equal(parseConnectLine('GET / HTTP/1.1'), null);
    const absolute = parseAbsoluteUrl('http://example.com/path?a=1');
    assert.equal(absolute.host, 'example.com');
    assert.equal(absolute.path, '/path?a=1');
    assert.equal(absolute.isHttps, false);
    assert.equal(findHeadEnd(Buffer.from('a\r\n\r\nb')), 5);
});

test('ip-utils: 内网/Tailscale 分类与公布地址', () => {
    assert.equal(ipv4ToInt('100.101.102.103') !== null, true);
    assert.equal(classifyIpv4('192.168.1.10'), 'lan');
    assert.equal(classifyIpv4('10.0.0.1'), 'lan');
    assert.equal(classifyIpv4('8.8.8.8'), 'other');
    assert.equal(classifyIpv4('not-an-ip'), 'unknown');
    const resolved = resolveAdvertiseAddresses({ advertiseIps: ['auto'], preferOrder: ['lan', 'other'] });
    assert.equal(Array.isArray(resolved.addresses), true);
});

test('ca: 生成并持久化根 CA，签发站点证书 SecureContext', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-ca-'));
    try {
        const ca = loadOrCreateRootCa(dir);
        assert.ok(fs.existsSync(ca.keyPath));
        assert.ok(fs.existsSync(ca.certPath));
        const der = getCaCertDer(ca);
        assert.equal(der.length > 0, true);
        // DER 证书以 ASN.1 SEQUENCE（0x30）开头
        assert.equal(der[0], 0x30);

        const ctx = getSecureContextForHost(ca, 'gate-obt.nqf.qq.com');
        assert.ok(ctx);
        // 重新加载应命中持久化文件
        const reloaded = loadOrCreateRootCa(dir);
        assert.equal(reloaded.certPem, ca.certPem);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
