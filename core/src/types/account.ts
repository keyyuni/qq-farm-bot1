export {};
export interface Account {
  id: string;
  name: string;
  code: string;
  platform: string;
  uin: string;
  qq: string;
  avatar: string;
  nick?: string;
  /** 账号归属用户名（多用户体系：普通用户只见自己的账号） */
  owner?: string;
  /** 抓包登录附加：游戏好友 GID */
  gid?: string;
  /** 抓包登录附加：微信 openId */
  openId?: string;
  /** 登录方式：qr / capture / manual 等 */
  loginType?: string;
  createdAt: number;
  updatedAt: number;
}

export interface AccountsData {
  accounts: Account[];
  nextId: number;
}
