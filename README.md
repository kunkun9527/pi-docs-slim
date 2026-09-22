# pi-slim

[Pi](https://pi.dev) 扩展，让内建 Pi 文档指引变为按需启用。此 fork 面向 **Pi 0.87.1 / pi-context-view 0.6.0**，基于 [robzolkos/pi-slim](https://github.com/robzolkos/pi-slim) 0.2.1。

普通请求移除 Pi 自动注入的文档指引，`/context` 的 Initial / Usage 数据也保持清理；不修改 Pi 核心。

## 安装

安装此 fork（不是 npm 上的上游版本）：

```bash
pi install git:github.com/kunkun9527/pi-slim
```

本地开发：

```bash
pi install ./
# 或临时加载
pi -e ./
```

## 使用

- `/pi <关于 Pi 的问题>`：本次运行保留原始文档指引，包括工具调用轮次；下一次普通请求恢复清理。
- 自定义 `<docs>`、项目指令和代码示例保留；不改写用户消息、助手回答或工具输出。
- 更新后执行 `/reload`，发送一条普通消息，再检查 `/context`。

## 兼容实现

上游 0.2.1 仅替换提示词字符串，没有处理 0.87.1 的结构化系统记录。本版本保留以下兼容逻辑，没有新增运行时依赖：

- 非空 docs 占位 + `message_end` 消息替换：阻止默认 docs 回填，并在写入会话前清除占位。
- `context_with_system`：清理请求中旧历史的系统 docs，保留工具声明和必要的 section 删除语义。
- 短暂的提示词展示覆盖：让 context-view 捕获清理后的提示，在 Pi 实际请求投影前恢复，不冻结 tools/rules。
- `AsyncLocalStorage`：将 `/pi` 关联到实际异步提交，避免输入被拦截后影响下一条请求。

入口为 `extensions/remove-pi-docs.ts`，文档识别和消息清理放在 `extensions/docs.ts`。包配置只加载入口文件。

## 验证与边界

在本目录运行 `npm test`。19 项测试使用真实 Pi 会话和 context-view 分析代码，模型响应来自离线 provider，不调用模型服务。覆盖结构化记录、Initial/Usage、扩展顺序、多轮工具切换、`/pi` 输入拦截、自定义 docs、文档解析及不可变清理。

测试需要已安装 Pi 0.87.1 和 pi-context-view 0.6.0，默认查找全局 Pi 和 `~/.pi/agent/npm/node_modules/pi-context-view`；其他布局可设置包目录：

```bash
PI_CODING_AGENT_DIR=/path/to/pi-coding-agent PI_CONTEXT_VIEW_DIR=/path/to/pi-context-view npm test
```

对照其他实现时可设置 `PI_SLIM_ENTRY`。

旧历史不重写；当前 Usage 在新的普通请求后清理。Initial 是首次捕获的冻结快照，旧快照需重新加载；若首次请求是显式 `/pi`，其中包含文档是预期行为。主动读取文档产生的工具输出不属于清理对象。

兼容逻辑依赖上述版本的事件顺序；升级后需重跑测试。其他扩展若在最终上下文处理之后重新注入文档，不保证清理。

## License

MIT。保留上游作者署名与许可证。
