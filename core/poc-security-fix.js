/**
 * 安全修复 PoC 验证（隔离环境：FARM_DATA_DIR 指向临时目录，端口 3977）
 * 验证项：1) 横向越权封堵  2) system-config 机密泄露封堵
 *         3) X-Forwarded-For 伪造绕过限速封堵  4) 免费领卡 UA 伪造绕过封堵
 */
process.env.FARM_DATA_DIR = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'farm-poc-'));
process.env.ADMIN_PORT = '3979';
process.env.FARM_ADMIN_USERNAME = 'admin';
process.env.FARM_ADMIN_PASSWORD = 'AdminPass123';
process.env.FARM_CARD_CLAIM_ENABLED = 'true';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// 预置：开启免费领卡 + 一张「免费」描述的未用加时卡
fs.writeFileSync(path.join(process.env.FARM_DATA_DIR, 'card-claim.json'),
    JSON.stringify({ enabled: true, records: [], reservations: [] }));
fs.writeFileSync(path.join(process.env.FARM_DATA_DIR, 'cards.json'),
    JSON.stringify({ cards: [{ id: 'c1', code: 'POC-TEST-CARD-0001', type: 'time', value: 30, description: '免费', enabled: true }] }));

const userStore = require('./dist/models/user-store');
const { startAdminServer } = require('./dist/controllers/admin');

// 模拟 dataProvider：alice 与 bob 各有一个账号
const provider = {
    getAccounts: () => ({ accounts: [
        { id: 'acc-a', name: 'alice-farm', owner: 'alice' },
        { id: 'acc-b', name: 'bob-farm', owner: 'bob' },
    ] }),
    getFriends: async () => [{ gid: 1001, name: 'friend' }],
    saveSettings: async () => ({ saved: true }),
    getStatus: () => ({ status: { nickname: 'x' } }),
};
startAdminServer(provider);

userStore.createUserByAdmin({ username: 'alice', password: 'AlicePass123' });
userStore.createUserByAdmin({ username: 'bob', password: 'BobPass123' });

const BASE = 'http://127.0.0.1:3979';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function req(method, url, { token, accountId, headers = {}, body } = {}) {
    const res = await fetch(BASE + url, {
        method,
        headers: {
            'content-type': 'application/json',
            ...(token ? { 'x-admin-token': token } : {}),
            ...(accountId ? { 'x-account-id': accountId } : {}),
            ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch {}
    return { status: res.status, data };
}

async function login(username, password, headers = {}) {
    return req('POST', '/api/login', { body: { username, password }, headers });
}

(async () => {
    await sleep(400);
    const results = [];
    const check = (name, cond, detail) => {
        results.push(`${cond ? '✅' : '❌'} ${name}${detail ? `  [${detail}]` : ''}`);
        if (!cond) process.exitCode = 1;
    };

    // 登录拿 token（注意：这些成功登录也占用同 IP 限速计数，先做少次数的关键验证）
    const la = await login('alice', 'AlicePass123');
    const lb = await login('bob', 'BobPass123');
    const ladm = await login('admin', 'AdminPass123');
    assert.ok(la.data?.data?.token && lb.data?.data?.token && ladm.data?.data?.token, '三个账号登录成功');
    const tA = la.data.data.token, tB = lb.data.data.token, tAdmin = ladm.data.data.token;

    // ---- 修复 1：横向越权（纵深防御验证）----
    // getAccId→resolveAccId 内部本就拒绝他人账号（返回空→400）；新增 canAccessAccount 为第二道防线（403）
    let r = await req('GET', '/api/friends', { token: tA, accountId: 'acc-b' });
    check('修复1: alice 读 bob 好友列表被拒', r.status === 403 || r.status === 400, `status=${r.status}`);
    r = await req('POST', '/api/friend/1001/op', { token: tA, accountId: 'acc-b', body: { opType: 'water' } });
    check('修复1: alice 对 bob 好友操作被拒', r.status === 403 || r.status === 400, `status=${r.status}`);
    r = await req('GET', '/api/friends', { token: tA, accountId: 'acc-a' });
    check('修复1: alice 读自己好友列表正常', r.status === 200 && r.data?.ok === true, `status=${r.status}`);
    r = await req('GET', '/api/friends', { token: tB, accountId: 'acc-b' });
    check('修复1: bob 读自己好友列表正常', r.status === 200, `status=${r.status}`);
    r = await req('GET', '/api/friends', { token: tAdmin, accountId: 'acc-b' });
    check('修复1: 超管操作任意账号不受影响', r.status === 200, `status=${r.status}`);
    r = await req('POST', '/api/ranch/harvest-all', { token: tA, accountId: 'acc-b', body: {} });
    check('修复1: alice 操作 bob 牧场被拒(commerce)', r.status === 403 || r.status === 400, `status=${r.status}`);
    r = await req('POST', '/api/settings/save', { token: tA, accountId: 'acc-b', body: {} });
    check('修复1: alice 改 bob 账号配置被拒', r.status === 403 || r.status === 400, `status=${r.status}`);
    r = await req('POST', '/api/settings/save', { token: tA, accountId: 'acc-a', body: {} });
    check('修复1: alice 保存自己账号配置正常', r.status === 200, `status=${r.status}`);

    // ---- 修复 2：system-config 机密泄露 ----
    r = await req('GET', '/api/settings/system-config', { token: tA });
    check('修复2: 普通用户读取全局设置被拒', r.status === 403, `status=${r.status}`);
    r = await req('GET', '/api/settings/system-config', { token: tAdmin });
    check('修复2: 超管读取全局设置正常', r.status === 200 && r.data?.ok === true, `status=${r.status}`);

    // ---- 修复 4：免费领卡 UA 伪造 ----
    r = await req('POST', '/api/card-claim/claim', { headers: { 'user-agent': 'UA-attacker-A' } });
    check('修复4: 第一次领卡成功', r.status === 200 && r.data?.ok === true, `status=${r.status}`);
    r = await req('POST', '/api/card-claim/claim', { headers: { 'user-agent': 'UA-attacker-B-totally-different' } });
    check('修复4: 换 UA 再领被 24h 限制拒绝', r.status === 400 && String(r.data?.error || '').includes('24'), `status=${r.status} error=${r.data?.error}`);

    // ---- 修复 3：伪造 X-Forwarded-For 绕过登录限速 ----
    // 限速窗口 60s 内每 IP 上限 10 次（此前已用 3 次成功登录）。
    // 连续用「每次不同的伪造 XFF」对 bob 错误密码登录：修复后所有请求同属 socket IP，第 8 次起应被 429。
    let saw429 = false, attempts = 0;
    for (let i = 0; i < 12; i++) {
        const rr = await login('bob', `WrongPass-${i}`, { 'x-forwarded-for': `10.9.9.${i}`, 'x-real-ip': `10.9.9.${i}` });
        attempts++;
        if (rr.status === 429) { saw429 = true; break; }
    }
    check(`修复3: 伪造 XFF 无法绕过登录限速（${attempts} 次内触发 429）`, saw429);

    // 未伪造头的合法登录此时也应被限（同 IP 计数），证明限速键与请求头无关
    r = await login('alice', 'AlicePass123');
    check('修复3: 限速计数不受请求头影响(同 IP 一样被限)', r.status === 429, `status=${r.status}`);

    console.log('\n===== PoC 验证结果 =====');
    results.forEach(line => console.log(line));
    process.exit(process.exitCode || 0);
})().catch(e => { console.error('POC FAILED:', e); process.exit(1); });
