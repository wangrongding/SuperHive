// 侧栏：label 是中文，translations.en 是英文页侧栏里的文字
const item = (label, en, slug) => ({ label, translations: { en }, slug });

export const navigation = [
  {
    label: "开始使用",
    translations: { en: "Getting started" },
    items: [
      item("快速上手", "Quickstart", "start/quickstart"),
      item("安装与更新", "Install and update", "start/installation"),
      item("功能地图", "Feature overview", "start/overview"),
    ],
  },
  {
    label: "使用指南",
    translations: { en: "Guides" },
    items: [
      item("接入 Agent", "Add agents", "guides/agents"),
      item("云端部署与多人共用", "Cloud deployment and team access", "guides/cloud-deployment"),
      item("权限与审批", "Permissions and approvals", "guides/permissions"),
      item("房间与成员", "Rooms and members", "guides/rooms"),
      item("消息与附件", "Messages and attachments", "guides/messaging"),
      item("委派、进展与提问", "Delegation, Progress and questions", "guides/collaboration"),
      item("任务状态与恢复", "Task states and recovery", "guides/tasks"),
      item("独立任务工作区", "Task directories", "guides/worktrees"),
      item("飞书与微信", "Feishu (Lark) and WeChat", "guides/im"),
      item("用量与费用", "Usage and cost", "guides/usage"),
      item("更新 SuperHive", "Updating SuperHive", "guides/updating"),
      item("反馈与贡献", "Feedback and contributing", "guides/contributing"),
      item("插件开发", "Building plugins", "guides/plugins"),
    ],
  },
  {
    label: "部署与参考",
    translations: { en: "Deploy & reference" },
    items: [
      item("部署 Hive 服务", "Deploy the Hive Server", "reference/deployment"),
      item("部署文档站", "Deploy the docs site", "reference/documentation"),
      item("CLI 速查", "CLI reference", "reference/cli"),
      item("常见问题", "Troubleshooting", "reference/troubleshooting"),
      item("安全边界", "Security boundaries", "reference/security"),
      item("开发与扩展", "Development and extensions", "reference/development"),
    ],
  },
];

export const locales = ["zh-CN", "en"];

/** 两种语言都要有的页面（相对站点前缀），英文页在 en/ 下 */
export const expectedRoutes = [
  "",
  ...navigation.flatMap((group) => group.items.map((item) => `${item.slug}/`)),
].flatMap((route) => [route, `en/${route}`]);

/** 某种语言下的侧栏文字 */
export const navLabel = (entry, lang) => (lang === "en" ? entry.translations.en : entry.label);
