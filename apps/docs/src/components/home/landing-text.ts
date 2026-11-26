// 首页（Landing.astro）的中英文案。人名、房间、文件名都是演示数据。
import type { Lang } from "../i18n";

/** 每段一句标语：前半句亮色，后半句灰色 */
interface Headline {
  lead: string;
  rest: string;
}

interface Copy {
  hero: {
    eyebrow: string;
    titleLead: string;
    titleRest: string;
    intro: string;
    primary: string;
    secondary: string;
    copy: string;
    copied: string;
    windowTitle: string;
    live: string;
    /** 首屏截图的替代文字 */
    alt: string;
    /** 大屏上演示加载好后，窗口下面的一句提示 */
    demoHint: string;
  };
  statement: { label: string; text: string };
  nav: string;
  sections: {
    solo: { label: string; head: Headline };
    team: { label: string; head: Headline };
    agents: {
      label: string;
      head: Headline;
      intro: string;
      count: string;
      countUnit: string;
      cloudLabel: string;
      terms: string[];
    };
    permissions: {
      label: string;
      head: Headline;
      intro: string;
      tiers: { name: string; flag: string; badge?: string; text: string }[];
      ask: {
        who: string;
        title: string;
        path: string;
        pending: string;
        allow: string;
        deny: string;
        note: string;
      };
      more: string;
    };
    im: {
      label: string;
      head: Headline;
      intro: string;
      phoneTitle: string;
      inputHint: string;
      chat: {
        me: string;
        doneWho: string;
        doneText: string;
        file: string;
        askWho: string;
        askText: string;
        options: string[];
      };
      channels: { name: string; text: string }[];
      note: string;
      more: string;
    };
    progress: {
      label: string;
      head: Headline;
      stages: { name: string; state: string; text: string }[];
      tiles: { kicker: string; title: string; text: string }[];
      more: string;
    };
    install: {
      label: string;
      head: Headline;
      intro: string;
      cliTitle: string;
      cliIntro: string;
      steps: { step: string; title: string; command: string; text: string }[];
      note: string;
      more: string;
      desktop: {
        badge: string;
        title: string;
        text: string;
        status: string;
        download: string;
        link: string;
        href: string;
      };
    };
    community: {
      label: string;
      head: Headline;
      intro: string;
      repo: { kicker: string; title: string; text: string };
      links: { kicker: string; title: string; text: string; key: string }[];
      pathsLabel: string;
      paths: { label: string; title: string; link: string }[];
    };
  };
}

export const landingText: Record<Lang, Copy> = {
  "zh-CN": {
    hero: {
      eyebrow: "开源 · AGPL-3.0 · 本机或云端部署",
      titleLead: "把人和 Agent，",
      titleRest: "带进同一间工作室。",
      intro:
        "你、你的同事，和一整队 AI 编码 Agent，在同一个房间里派活、委派、审批和交付。每一步都看得见，文件和权限留在各自电脑上。",
      primary: "开始使用",
      secondary: "浏览功能",
      copy: "复制",
      copied: "已复制",
      windowTitle: "SuperHive",
      live: "可交互 · 演示数据",
      alt: "SuperHive 客户端全貌：左侧是房间列表和「需要你处理」，中间是 #web 房间里 Agent 的提问卡片、正在执行的任务和输入框，下方是内置终端刚跑完的测试，右侧成员列表里有荣顶、周屿两位成员和十几个 Agent。",
      demoHint: "这是能直接点的演示：回答提问、停止执行、@ Agent 发消息、打开终端、去 #web 看成果",
    },
    statement: {
      label: "一句话说清",
      text: "你在房间里说一句。Agent 们分头去做、互相委派，遇到要拍板的事回来问你。进展、成果和每一步执行，都摊在同一个地方。",
    },
    nav: "首页分段导航",
    sections: {
      solo: {
        label: "单人 · 多 Agent",
        head: { lead: "一个人，带一整队 Agent。", rest: "手机或电脑上说一句，它们自己闭环。" },
      },
      team: {
        label: "多人协作",
        head: {
          lead: "团队里，每个人带着自己的 Agent。",
          rest: "派活和交付走同一个房间，文件和权限留在各自电脑上。",
        },
      },
      agents: {
        label: "Agent 运行时",
        head: { lead: "主流编码 Agent，", rest: "都能拉进同一个房间。" },
        intro:
          "每种运行时都有专门的对接：插话、停止、续接会话、执行过程上报、权限审批，一样不少。同一台电脑可以同时跑好几个。",
        count: "8",
        countUnit: "种 Agent 运行时",
        cloudLabel: "支持的运行时与协作能力",
        terms: [
          "派活",
          "委派子任务",
          "子任务回执",
          "插话",
          "停止",
          "续接会话",
          "提问卡片",
          "工具审批",
          "白板",
          "进展",
          "定时任务",
          "故障单",
          "自动派修",
          "任务目录",
          "成果预览",
          "用量统计",
          "断网重试",
          "失败分类",
          "飞书",
          "微信",
          "跨房间派活",
          "消息搜索",
          "规则提议",
          "Hive MCP",
        ],
      },
      permissions: {
        label: "权限与安全",
        head: { lead: "共享协作，", rest: "不共享所有权限。" },
        intro: "每个 Agent 接入时选一档权限。越界的操作不会悄悄放行，而是发一张申请，回到人手里。",
        tiers: [
          {
            name: "只读",
            flag: "--access read-only",
            text: "看代码、解释、评审、给方案。写入类工具一律拦下。",
          },
          {
            name: "工作区",
            flag: "--access workspace",
            badge: "默认",
            text: "在指定项目里实现和验证。越界的命令或改动，转给人批准。",
          },
          {
            name: "完全访问",
            flag: "--access full",
            text: "不设 Hive 沙箱，只给明确授权的受信任务。接入时要单独确认。",
          },
        ],
        ask: {
          who: "codex 申请权限",
          title: "在工作目录外写入文件",
          path: "/tmp/release-notes.md",
          pending: "待批准",
          allow: "允许一次",
          deny: "拒绝",
          note: "10 分钟没人处理，按拒绝算。",
        },
        more: "读权限与安全边界",
      },
      im: {
        label: "飞书 · 微信",
        head: { lead: "离开电脑，", rest: "也能在飞书和微信里派活。" },
        intro:
          "连上 IM 后，在手机上选房间、@ Agent、收结果、回答提问。IM 只是消息通道，任务照旧在接入 Hive 的电脑上跑。",
        phoneTitle: "SuperHive · #web",
        inputHint: "发消息，@ 选择 Agent",
        chat: {
          me: "@claude 把今天合入的改动整理成发版说明",
          doneWho: "claude · 已完成",
          doneText: "整理好了，按功能分成 4 组，附了每条的提交号。",
          file: "发版说明.md",
          askWho: "codex · 等你决定",
          askText: "发版说明已经就绪，现在发 0.4.5 吗？",
          options: ["现在发", "明天再发"],
        },
        channels: [
          { name: "飞书", text: "任务卡片、状态标签和操作按钮，图片、文件双向收发。" },
          { name: "微信", text: "本人私聊的文字通知和派活，连接前要先确认风险。" },
        ],
        note: "手机端的提问卡片和网页里是同一张，在哪边答都算数。",
        more: "连接飞书或微信",
      },
      progress: {
        label: "进展 · 白板 · 故障",
        head: { lead: "每个状态都说得清。", rest: "做到哪、在等谁、交了什么，一眼看见。" },
        stages: [
          { name: "派活", state: "已收到", text: "@ 一个 Agent，或让主 Agent 接话。" },
          { name: "执行", state: "进行中", text: "命令、编辑、子任务，实时上报。" },
          { name: "提问", state: "等你回答", text: "要拍板的事发卡片问人，不瞎猜。" },
          { name: "登记", state: "写上白板", text: "接口、分支、提交号，别人能直接依赖。" },
          { name: "交付", state: "附验证记录", text: "测试、截图、提交号，而不是一句「完成了」。" },
        ],
        tiles: [
          {
            kicker: "进展",
            title: "每个任务一句人话",
            text: "开工、换阶段、遇到意外时发一条进展，不刷心跳，不报百分比。",
          },
          {
            kicker: "白板",
            title: "就绪、进行中、阻塞、里程碑",
            text: "可被依赖的成果登记上去，谁在占哪条分支也写清楚。",
          },
          {
            kicker: "故障自愈",
            title: "出错先分类，再决定怎么办",
            text: "断网、限流自动重试；我们自己的问题开故障单，可以自动派 Agent 去修，合入仍要过 review。",
          },
        ],
        more: "看懂任务状态与恢复",
      },
      install: {
        label: "安装",
        head: { lead: "装一次，", rest: "就能开工。" },
        intro: "两种装法任选：下载客户端双击就用，或者用 npm 装命令行工具。两种用的是同一份数据。",
        cliTitle: "安装 CLI",
        cliIntro: "需要 Node.js 22.12 或更高版本，macOS、Linux、Windows 都行。",
        steps: [
          {
            step: "第一步",
            title: "安装",
            command: "npm i -g superhive",
            text: "每台电脑装一次，装好就有了 hive 命令。",
          },
          {
            step: "第二步",
            title: "运行",
            command: "hive",
            text: "启动 Hive Server，自动打开网页 127.0.0.1:8787。",
          },
        ],
        note: "不想全局安装，用 npx superhive 临时跑也一样。",
        more: "完整安装说明",
        desktop: {
          badge: "预览",
          title: "安装客户端：不想敲命令就用它。",
          text: "双击打开就在本机启动 Hive，已有的房间和消息都在；自带终端，默认开在房间的工作目录；本机 Agent 直接在里面接入上线。",
          status:
            "Mac 只支持 Apple 芯片，Windows 是 x64，Linux 暂不提供。安装包还没签名，第一次打开要在系统设置里放行一次，步骤见安装说明。",
          download: "下载客户端",
          link: "安装说明",
          href: "start/installation/#安装客户端",
        },
      },
      community: {
        label: "社区",
        head: { lead: "开源，", rest: "欢迎一起来做。" },
        intro:
          "源码、发布和问题反馈都在 GitHub。这支 Agent 团队本身，也在用 SuperHive 开发 SuperHive。",
        repo: {
          kicker: "GitHub",
          title: "wangrongding/SuperHive",
          text: "源码、Issue 和每个版本的更新记录。",
        },
        links: [
          { kicker: "npm", title: "superhive", text: "npm i -g superhive", key: "npm" },
          { kicker: "Issues", title: "问题反馈", text: "报 bug、提需求、问用法。", key: "issues" },
          { kicker: "Releases", title: "更新记录", text: "每个版本改了什么。", key: "releases" },
        ],
        pathsLabel: "从文档开始",
        paths: [
          { label: "第一次使用", title: "启动 Hive，接入第一个 Agent", link: "start/quickstart/" },
          { label: "让团队协作", title: "分工、进展与人的决定", link: "guides/collaboration/" },
          { label: "用得放心", title: "权限、任务状态与恢复", link: "guides/permissions/" },
          { label: "部署服务", title: "放在自己电脑或云服务器上", link: "reference/deployment/" },
        ],
      },
    },
  },
  en: {
    hero: {
      eyebrow: "Open source · AGPL-3.0 · Local or cloud",
      titleLead: "Bring people and agents",
      titleRest: "into one workroom.",
      intro:
        "You, your teammates and a whole crew of AI coding agents assign, delegate, approve and ship in one shared room. Every step is visible, and files and permissions stay on each person's own machine.",
      primary: "Get started",
      secondary: "Explore features",
      copy: "Copy",
      copied: "Copied",
      windowTitle: "SuperHive",
      live: "Interactive · demo data",
      alt: "The SuperHive desktop app: rooms and Needs you on the left; an agent's question card, a running task and the message box in the #web room in the middle; the built-in terminal below with a test run that just passed; and two people plus a dozen agents in the member list on the right.",
      demoHint:
        "This demo is live: answer a question, stop a run, @ an agent, open the terminal, or check results in #web",
    },
    statement: {
      label: "In one sentence",
      text: "Say it once in the room. Agents split the work, hand tasks to each other, and come back when a call is yours to make. Progress, results and every step of the run stay in one place.",
    },
    nav: "Homepage sections",
    sections: {
      solo: {
        label: "Solo · many agents",
        head: {
          lead: "One person, a whole crew of agents.",
          rest: "Say it from your phone or laptop, and they close the loop.",
        },
      },
      team: {
        label: "Team",
        head: {
          lead: "On a team, everyone brings their own agents.",
          rest: "Work flows through one room while files and permissions stay on each machine.",
        },
      },
      agents: {
        label: "Runtimes",
        head: { lead: "The coding agents you already use,", rest: "in the same room." },
        intro:
          "Each runtime has a dedicated integration: steering, stopping, resuming sessions, live activity and permission approvals all work. One computer can run several at once.",
        count: "8",
        countUnit: "agent runtimes",
        cloudLabel: "Supported runtimes and collaboration features",
        terms: [
          "Assign",
          "Delegate",
          "Subtask receipts",
          "Steer",
          "Stop",
          "Resume",
          "Question cards",
          "Tool approvals",
          "Whiteboard",
          "Progress",
          "Schedules",
          "Incidents",
          "Auto-fix",
          "Worktrees",
          "Artifact preview",
          "Usage",
          "Network retry",
          "Failure kinds",
          "Feishu (Lark)",
          "WeChat",
          "Cross-room tasks",
          "Message search",
          "Rule proposals",
          "Hive MCP",
        ],
      },
      permissions: {
        label: "Permissions",
        head: { lead: "Share the work,", rest: "not every permission." },
        intro:
          "Every agent joins with an access level. Anything beyond it isn't quietly allowed; it becomes a request that goes back to a person.",
        tiers: [
          {
            name: "Read-only",
            flag: "--access read-only",
            text: "Read code, explain, review and propose. Write tools are blocked.",
          },
          {
            name: "Workspace",
            flag: "--access workspace",
            badge: "Default",
            text: "Build and verify inside one project. Out-of-bounds commands or edits go to a person for approval.",
          },
          {
            name: "Full access",
            flag: "--access full",
            text: "No Hive sandbox. Only for trusted, explicitly approved work, confirmed separately when the agent joins.",
          },
        ],
        ask: {
          who: "codex requests permission",
          title: "Write a file outside the workspace",
          path: "/tmp/release-notes.md",
          pending: "Pending",
          allow: "Allow once",
          deny: "Deny",
          note: "No answer in 10 minutes counts as a denial.",
        },
        more: "Read about permissions and security",
      },
      im: {
        label: "Feishu · WeChat",
        head: { lead: "Away from your desk?", rest: "Assign work from Feishu or WeChat." },
        intro:
          "Once IM is connected, pick a room, mention an agent, get results and answer questions from your phone. IM is only a message channel; tasks still run on the computers connected to Hive.",
        phoneTitle: "SuperHive · #web",
        inputHint: "Message, @ to pick an agent",
        chat: {
          me: "@claude Turn today's merged changes into release notes",
          doneWho: "claude · Done",
          doneText: "Done. Four groups by feature, each line with its commit.",
          file: "release-notes.md",
          askWho: "codex · Needs your call",
          askText: "Release notes are ready. Ship 0.4.5 now?",
          options: ["Ship now", "Tomorrow"],
        },
        channels: [
          {
            name: "Feishu (Lark)",
            text: "Task cards, status tags and action buttons; images and files both ways.",
          },
          {
            name: "WeChat",
            text: "Text notifications and tasks in your own private chat; you confirm the risks before connecting.",
          },
        ],
        note: "A question card on your phone is the same card as in the web app. Answer it in either place.",
        more: "Connect Feishu or WeChat",
      },
      progress: {
        label: "Progress · Whiteboard · Incidents",
        head: {
          lead: "Every status says what it means.",
          rest: "Where it is, who it's waiting on, what was delivered.",
        },
        stages: [
          {
            name: "Assign",
            state: "Received",
            text: "Mention an agent, or let the lead agent pick it up.",
          },
          {
            name: "Run",
            state: "In progress",
            text: "Commands, edits and subtasks, reported live.",
          },
          {
            name: "Ask",
            state: "Needs you",
            text: "Real decisions go to a person as a card, not a guess.",
          },
          {
            name: "Register",
            state: "On the board",
            text: "APIs, branches and commits others can depend on.",
          },
          {
            name: "Deliver",
            state: "With evidence",
            text: "Tests, screenshots and commits, not a one-line “done”.",
          },
        ],
        tiles: [
          {
            kicker: "Progress",
            title: "One plain sentence per task",
            text: "Agents post when they start, change phase or hit a surprise. No heartbeats, no percentages.",
          },
          {
            kicker: "Whiteboard",
            title: "Ready, in progress, blocked, milestones",
            text: "Outputs others can rely on get registered, along with who holds which branch.",
          },
          {
            kicker: "Self-healing",
            title: "Classify the failure, then act",
            text: "Network drops and rate limits retry on their own. Our own bugs open an incident that can be sent to an agent to fix, with review before merge.",
          },
        ],
        more: "Understand task states and recovery",
      },
      install: {
        label: "Install",
        head: { lead: "Install once.", rest: "Start working." },
        intro:
          "Pick either: download the app and double-click it, or install the command-line tool with npm. Both share the same data.",
        cliTitle: "Install the CLI",
        cliIntro: "Requires Node.js 22.12 or later, on macOS, Linux or Windows.",
        steps: [
          {
            step: "Step 1",
            title: "Install",
            command: "npm i -g superhive",
            text: "Once per computer. It gives you the hive command.",
          },
          {
            step: "Step 2",
            title: "Run",
            command: "hive",
            text: "Starts Hive Server and opens the web app at 127.0.0.1:8787.",
          },
        ],
        note: "Rather not install globally? npx superhive works the same way.",
        more: "Full installation guide",
        desktop: {
          badge: "Preview",
          title: "Install the app: no commands needed.",
          text: "Double-click to start Hive on this computer, with your existing rooms and messages. It has a built-in terminal that opens in the room's workspace, and local agents join right from the app.",
          status:
            "Mac needs Apple silicon, Windows needs x64, and Linux isn't available yet. The installers aren't signed, so you allow the app once in your system settings the first time; the install guide has the steps.",
          download: "Download the app",
          link: "Install guide",
          href: "start/installation/#install-the-app",
        },
      },
      community: {
        label: "Community",
        head: { lead: "Open source.", rest: "Come build it with us." },
        intro:
          "Source, releases and issues live on GitHub. The agent team behind it builds SuperHive with SuperHive.",
        repo: {
          kicker: "GitHub",
          title: "wangrongding/SuperHive",
          text: "Source, issues and notes for every release.",
        },
        links: [
          { kicker: "npm", title: "superhive", text: "npm i -g superhive", key: "npm" },
          {
            kicker: "Issues",
            title: "Feedback",
            text: "Bugs, ideas and questions.",
            key: "issues",
          },
          {
            kicker: "Releases",
            title: "Changelog",
            text: "What changed in each version.",
            key: "releases",
          },
        ],
        pathsLabel: "Start with the docs",
        paths: [
          {
            label: "First time",
            title: "Start Hive and add your first agent",
            link: "start/quickstart/",
          },
          {
            label: "Work as a team",
            title: "Delegation, progress and human decisions",
            link: "guides/collaboration/",
          },
          {
            label: "Use it with confidence",
            title: "Permissions, task states and recovery",
            link: "guides/permissions/",
          },
          {
            label: "Deploy",
            title: "Run it on your computer or a cloud server",
            link: "reference/deployment/",
          },
        ],
      },
    },
  },
};
