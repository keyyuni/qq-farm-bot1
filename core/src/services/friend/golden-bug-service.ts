/**
 * 黄金虫服务 —— 从源码 qq-farm-bot 移植（services/golden-bug-service.js）。
 * 在好友农场投放背包中的黄金虫（道具 301101），获取经验。
 */

const { isAutomationOn, getConfigSnapshot, getFriendBlacklist } = require('../../models/store');
export {};
const { getUserState, sendMsgAsync } = require('../../utils/network');
const { types } = require('../../utils/proto');
const { log, logWarn, randomDelay, toLong, toNum } = require('../../utils/utils');
const {
    enterFriendFarm,
    leaveFriendFarm,
    getAllFriends,
} = require('./api');
const { extractReplyFriends } = require('./gid-manager');
const {
    analyzeFriendLands,
    handleFriendEnterError,
    inFriendQuietHours,
    GOLDEN_BUG_ITEM_ID,
    GOLDEN_BUG_SOCIAL_TYPE,
} = require('./visit-strategy');
const {
    checkDailyReset,
    getRemainingTimes,
    updateOperationLimits,
} = require('./scheduler');
const { getBag, getBagItems } = require('../warehouse');
const { recordOperation } = require('../stats');

const GOLDEN_BUG_OPERATION_ID = 10015;
export const GOLDEN_BUG_DAILY_LIMIT = 100;
const MIN_RUN_INTERVAL_MS = 10 * 60 * 1000;

let lastRunAt = 0;
let running = false;

export function getGoldenBugCount(items: any[]): number {
    return (Array.isArray(items) ? items : []).reduce((total: number, item: any) => (
        toNum(item && item.id) === GOLDEN_BUG_ITEM_ID
            ? total + Math.max(0, toNum(item && item.count))
            : total
    ), 0);
}

export async function putGoldenBug(gid: number, landId: number): Promise<any> {
    const payload: Uint8Array = types.PutSocialItemRequest.encode(
        types.PutSocialItemRequest.create({
            host_gid: toLong(gid),
            land_ids: [toLong(landId)],
            item_id: toLong(GOLDEN_BUG_ITEM_ID),
            social_type: toLong(GOLDEN_BUG_SOCIAL_TYPE),
        }),
    ).finish();
    const { body } = await sendMsgAsync(
        'gamepb.plantpb.PlantService',
        'PutSocialItem',
        payload,
    );
    const reply: any = types.PutSocialItemReply.decode(body);
    updateOperationLimits(reply.operation_limits);
    return reply;
}

export async function runGoldenBugPlacement(options: { force?: boolean } = {}): Promise<any> {
    if (running
        || !isAutomationOn('friend')
        || !isAutomationOn('friend_golden_bug')
        || inFriendQuietHours()) return null;

    const now = Date.now();
    if (!options.force && now - lastRunAt < MIN_RUN_INTERVAL_MS) return null;

    running = true;
    lastRunAt = now;
    try {
        const userState: any = getUserState();
        if (!toNum(userState && userState.gid)) return null;

        const accountId: string = process.env.FARM_ACCOUNT_ID || '';
        const config: any = getConfigSnapshot(accountId);
        const keepCount: number = Math.max(0, toNum(config.goldenBugKeepCount));
        const roundLimit: number = Math.max(1, Math.min(100, toNum(config.goldenBugRoundLimit) || 24));
        const bag: any = await getBag();
        const inventory: number = getGoldenBugCount(getBagItems(bag));
        const usableInventory: number = Math.max(0, inventory - keepCount);
        checkDailyReset();
        const dailyRemaining: number = Math.min(getRemainingTimes(GOLDEN_BUG_OPERATION_ID), GOLDEN_BUG_DAILY_LIMIT);
        let remaining: number = Math.min(usableInventory, dailyRemaining, roundLimit);

        if (remaining <= 0) return { placed: 0, inventory, dailyRemaining };

        const allFriendsReply: any = await getAllFriends();
        const blacklist = new Set(((getFriendBlacklist(accountId) || []) as any[]).map((gid: any) => toNum(gid)));
        const friends: any[] = extractReplyFriends(allFriendsReply)
            .map((friend: any) => ({
                gid: toNum(friend && friend.gid),
                name: (friend && (friend.remark || friend.name)) || '',
                level: toNum(friend && friend.level),
            }))
            .filter((friend: any) => friend.gid > 0 && friend.gid !== toNum(userState.gid) && !blacklist.has(friend.gid))
            .sort((a: any, b: any) => b.level - a.level);

        let placed = 0;
        let consecutiveFailures = 0;
        for (const friend of friends) {
            if (remaining <= 0) break;

            let entered = false;
            try {
                const enterReply: any = await enterFriendFarm(friend.gid);
                entered = true;
                const analysis: any = analyzeFriendLands(
                    enterReply.lands || [],
                    toNum(userState.gid),
                    friend.name,
                );
                const targets: number[] = (analysis.canPutGoldenBug || []).slice(0, remaining);

                for (const landId of targets) {
                    try {
                        await putGoldenBug(friend.gid, landId);
                        placed++;
                        remaining--;
                        consecutiveFailures = 0;
                        recordOperation('goldenBugPut', 1);
                        await randomDelay(500, 1000);
                    }
                    catch (err: any) {
                        const message = String((err && err.message) || '未知错误');
                        logWarn('好友', `给 ${friend.name || `GID:${friend.gid}`} 放置黄金虫失败: ${message}`, {
                            module: 'friend',
                            event: '放置黄金虫',
                            result: 'error',
                            friendGid: friend.gid,
                            landId,
                        });
                        consecutiveFailures++;
                        if (consecutiveFailures >= 3) remaining = 0;
                        break;
                    }
                }
            }
            catch (err: any) {
                handleFriendEnterError(friend.gid, friend.name || `GID:${friend.gid}`, err);
            }
            finally {
                if (entered) {
                    try { await leaveFriendFarm(friend.gid); }
                    catch {}
                }
            }

            if (remaining > 0) await randomDelay(500, 1500);
        }

        if (placed > 0) {
            log('好友', `黄金虫投放完成 ${placed} 只，获得经验 ${placed * 30}`, {
                module: 'friend',
                event: '放置黄金虫',
                result: 'ok',
                count: placed,
                exp: placed * 30,
                inventoryBefore: inventory,
            });
        }
        return { placed, inventory, dailyRemaining };
    }
    catch (err: any) {
        logWarn('好友', `黄金虫投放检查失败: ${err.message}`, {
            module: 'friend',
            event: '放置黄金虫',
            result: 'error',
        });
        return null;
    }
    finally {
        running = false;
    }
}

// GOLDEN_BUG_ITEM_ID / GOLDEN_BUG_SOCIAL_TYPE 从 ./visit-strategy 导出，避免循环依赖重复定义
