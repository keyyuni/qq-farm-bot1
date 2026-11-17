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

test('插件素材库补齐的作物（原 core/src 清单缺失）阶段图可取', () => {
    // 仙人掌(20107→Crop_107)、寒兰(21072→Crop_1072) 只在插件素材库 manifest 中登记，
    // 合并素材后这些作物不能再显示空白（回归：曾因只复制 core/src 一套素材而缺图）。
    for (const plantId of [1020107, 1021072, 1020117]) {
        const url = getPlantImageByPhase(plantId, 3);
        assert.ok(url, `作物 ${plantId} 阶段3 应返回贴图 URL`);
        assert.match(url, /^\/game-config\/plant_images\//);
    }
});

test('无 seed_id 的黄金作物通过果实 ItemInfo.asset_name 兜底取图', () => {
    // 黄金·森野甜莓 1120525 无 seed_id，需经 fruit.id=1040525 的
    // asset_name=gold/Crop_525 命中 gold 阶段图（回归：此前推导成 Plant_1120525 取不到）。
    const url = getPlantImageByPhase(1120525, 3);
    assert.ok(url, '黄金·森野甜莓阶段3 应返回贴图 URL');
    assert.match(url, /^\/game-config\/plant_images\/gold\/Crop_525\//);
    assert.match(url, /3\.png$/);
});

test('多 asset_name 候选中后者可命中时不被前者空图覆盖', () => {
    // 黄金·风信子等作物同时存在多条 asset_name 推导路径；
    // 取图逻辑须逐个候选尝试，不能只取第一个非空名就放弃。
    const url = getPlantImageByPhase(1120112, 3); // 黄金·风信子
    assert.ok(url, '黄金·风信子阶段3 应能经回退候选取到图');
    assert.match(url, /^\/game-config\/plant_images\//);
});
