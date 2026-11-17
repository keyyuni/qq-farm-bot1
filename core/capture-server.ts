export {};
/**
 * 抓包服务 CLI 入口
 *
 * 启动后提供：
 * - REST API：默认 http://127.0.0.1:8450（bot 管理面板的“抓包登录”使用）
 * - MITM 代理端口：默认随机 2000-9999（可用 CAPTURE_PORTS 固定），绑定全部网卡 IP（局域网 / Tailscale）
 *
 * 配置见 <core>/data/capture/config.json，或使用 CAPTURE_* 环境变量。
 *
 * 运行：pnpm capture:start（tsx）或 node dist/capture-server.js（编译产物）
 */

const process = require('node:process');
const path = require('node:path');
const fs = require('node:fs');

// tsx 直接跑本文件时用 src，node dist 时用 dist（与 client.ts 策略一致）
const runningFromSource = /\.[cm]?tsx?$/.test(__filename);
const distDir = path.join(__dirname, 'dist');
const baseDir = !runningFromSource && fs.existsSync(distDir) ? './dist' : './src';

const { startCaptureServer } = require(`${baseDir}/capture/index`);
const { resolveAdvertiseAddresses } = require(`${baseDir}/capture/ip-utils`);

async function main(): Promise<void> {
    const { config, stop, log } = await startCaptureServer();

    const advertise = resolveAdvertiseAddresses(config);
    log('info', '抓包服务启动完成');
    log('info', `API: http://${config.apiHost}:${config.apiPort}`);
    log('info', `代理端口: ${config.proxyPortFrom}`);
    log('info', `代理绑定 IP: ${(config.proxyBind || []).join(', ')}`);
    log('info', `对外代理地址（手机 Wi-Fi 代理填写）: ${advertise.addresses.length
        ? advertise.addresses.map(item => `${item.address}:<代理端口> (${item.kind})`).join(', ')
        : '未检测到可用地址，请检查 CAPTURE_ADVERTISE_IPS 配置'}`);

    const shutdown = async (signal: string) => {
        log('info', `收到 ${signal}，正在关闭...`);
        await stop();
        process.exit(0);
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error: any) => {
    console.error('[capture] 启动失败:', error && error.message ? error.message : error);
    process.exit(1);
});
