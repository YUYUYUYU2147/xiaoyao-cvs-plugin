#### 介绍

## 特别说明

更新可能不及时

# xiaoyao-cvs-plugin

yunzai-bot扩展图鉴以及体力优化;

项目仅供学习交流使用，严禁用于任何商业用途和非法行为

#### 介绍

原神星铁图鉴插件。

#### 软件架构

由逍遥自行制作的原神图鉴，按业务分类整理。图片更新时替换对应路径的文件，保持图片url不变~
其余功能支持：stoken相关功能支持、云原神签到支持、扫码登录

#### 安装教程

使用cnb

```
git clone https://cnb.cool/rainbowwarmth/xiaoyao-cvs-plugin.git ./plugins/xiaoyao-cvs-plugin/
**git clone https://cnb.cool/tar/xiaoyao-cvs-plugin.git ./plugins/xiaoyao-cvs-plugin/**
```

使用github

```
git clone https://github.com/Ctrlcvs/xiaoyao-cvs-plugin.git ./plugins/xiaoyao-cvs-plugin/
```

#### 使用说明

配合云崽使用： https://gitee.com/Le-niao/Yunzai-Bot

配合喵崽使用： https://gitee.com/yoimiya-kokomi/Miao-Yunzai.git

配合TRSS崽使用： https://gitee.com/TimeRainStarSky/Yunzai

#### 命令说明

1. 发送 【#图鉴更新】 获取最新的图鉴记录。(必须)
2. 发送 【#\*\*信息】 进行触发，例如发送 #刻晴信息，即可返回对应的图片信息。
3. 发送 【#图鉴插件更新】获取最新代码。
4. 别名文件在 /xiaoyao-cvs-plugin/resources/Atlas_alias 目录下面，当前只支持武器、食物、原魔、七圣召唤的别名。
5. 发送 #图鉴帮助 获取帮助面板。
6. 发送 #图鉴设置 获取图鉴管理面板。(如果图鉴喊不出来，大概率是没开设置)
7. 发送 #图鉴版本 获取图鉴更新日志。
8. 其余具体功能通过 #图鉴帮助 #图鉴版本 查看。
9. 发送 #崩坏3签到 可签到崩坏3游戏模块 具体支持【崩坏3、原神、崩坏2、未定义事件。绝区零】。
10. 发送 #云原神签到 可签到云原神游戏。
11. 默认配置文件位于 ./plugins/xiaoyao-cvs-plugin/defSet/config/config.yaml
12. 支持stoken绑定以及相关的操作。如：【#更新抽卡记录】
13. 崩铁跃迁摘要更新：先在微信小程序“崩坏：星穹铁道”的跃迁记录统计页抓取 `five_star_list` 请求，复制请求头中 `Cookie:` 后面的完整值（不要复制 `Cookie:` 前缀、引号或响应中的 `Set-Cookie`），再私聊发送 `*绑定跃迁Cookie <完整小程序Cookie>`，最后发送 `*更新抽卡记录`。标准 `#绑定Cookie` 会裁剪小程序字段，不能替代此步骤。该接口目前只返回五星和当前垫抽摘要，不包含四星或完整逐抽记录；`e_hkrpg_token` 有效期约48小时，失效后需重新抓取。

##后续计划
关于插件兼容以及支持问题：

    由于喵崽目前uid以及ck管理部分正在重写盲目兼容只会不断的进行修改以及完善，如非必要情况可以先不急更新主体

    画个大饼，等随缘咕咕咕

## 其他

<!---
- 有什么问题、Bug，或有其它建议，欢迎提 [issue](https://github.com/Ctrlcvs/xiaoyao-cvs-plugin/issues)
-->

- [爱发电](https://afdian.net/a/Ctrlcvs)
- 最后再求个star，你的支持是维护本项目的动力~~
- 图片素材来源于网络，仅供交流学习使用
- 严禁用于任何商业用途和非法行为
- Yunzai-Bot 官方QQ群：213938015 （暂时停止新加入）
- 喵喵Miao-Plugin QQ群：755269874 （暂时停止新加入）
- 闲聊群 342996701
