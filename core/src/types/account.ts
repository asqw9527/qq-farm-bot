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
  // 多用户体系：账号归属的用户名，空表示未绑定（兼容旧数据）
  username?: string;
  // 微信：openid 用于识别账号身份，loginBuffer 是换取新 code 的长凭据。
  // loginBuffer 属于敏感字段，只落盘、不通过账号列表接口返回浏览器。
  wxid?: string;
  loginBuffer?: string;
  // 账号级 NapCat 配置（仅 QQ 使用）。留空回落到全局 loginSettings，
  // 支持多账号各指向不同 NapCat 实例（NapCat 单实例只能登一个 QQ）。
  napCatBase?: string;
  napCatKey?: string;
  // 农夫小程序 appid 与客户端版本，留空使用默认值/系统配置
  appId?: string;
  ver?: string;
  createdAt: number;
  updatedAt: number;
}

export interface AccountsData {
  accounts: Account[];
  nextId: number;
}
