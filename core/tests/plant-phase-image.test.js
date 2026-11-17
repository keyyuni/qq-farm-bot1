const test = require('node:test');
const assert = require('node:assert/strict');
const {
    getPlantImageByPhase,
    getMutantPlantImageByPhase,
} = require('../dist/config/gameConfig');

test('种子阶段(phase=1)统一使用通用种子贴图', () => {
    const url = getPlantImageByPhase(1020002, 1); // 白萝卜
    assert.equal(url, '/game-config/plant_images/common/seed.png');
});

test('生长阶段返回客户端导出贴图，且 URL 指向 /game-config/plant_images', () => {
    // 用 manifest 里真实存在的作物验证各阶段都能取到图
    const plantId = 1020002; // 白萝卜
    for (const phase of [2, 3, 4, 5, 6]) {
        const url = getPlantImageByPhase(plantId, phase);
        assert.ok(url, `阶段 ${phase} 应返回贴图 URL`);
        assert.match(url, /^\/game-config\/plant_images\//);
        assert.match(url, new RegExp(`/${phase}\\.png$`));
    }
});

test('无效植物 ID 返回空串，不抛错', () => {
    assert.equal(getPlantImageByPhase(0, 5), '');
    assert.equal(getPlantImageByPhase(999999999, 5), '');
});

test('无变异时 getMutantPlantImageByPhase 与普通取图一致', () => {
    const plantId = 1020002;
    assert.equal(
        getMutantPlantImageByPhase(plantId, [], 3),
        getPlantImageByPhase(plantId, 3),
    );
});

test('manifest 已加载足够多的作物阶段映射', () => {
    // 取一个 manifest 中确认存在的作物，确保资源与加载逻辑都生效
    const url = getPlantImageByPhase(1020059, 4); // 大白菜
    assert.ok(url && url.startsWith('/game-config/plant_images/'));
});
