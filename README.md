# BeitaProxy

<p align="center">
  <img src="assets/Icon.png" width="120" alt="BeitaProxy icon">
</p>

<p align="center">
  <img alt="Platform" src="https://img.shields.io/badge/platform-Electron-47848f">
  <img alt="License" src="https://img.shields.io/badge/license-MIT-28a745">
  <img alt="Backend" src="https://img.shields.io/badge/backend-CLIProxyAPI-4b3baf">
</p>

<p align="center">
  English | <a href="#中文说明">中文</a>
</p>

A desktop AI proxy app built with Electron and powered by [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI).

## Quick Links

- [Overview](#overview)
- [Highlights](#highlights)
- [Supported Services](#supported-services)
- [Architecture](#architecture)
- [Quick Start](#quick-start)
- [Project Structure](#project-structure)
- [中文说明](#中文说明)

---

## Overview

BeitaProxy provides a unified local proxy for multiple AI services, so local tools such as Cursor, Continue, and Cline can connect through a single endpoint.

It is designed for users who want to reuse their existing service subscriptions through a local desktop app instead of managing separate API integrations for each tool.

## Highlights

- Electron-based desktop app
- Unified local proxy endpoint for AI tools
- Built-in settings and account management UI
- OAuth-based login for supported providers
- Multi-account support for selected providers
- Launch-at-login support
- Local proxy configuration support
- Dashboard entry for backend management page
- Extended thinking support for Claude-compatible model naming

## Supported Services

- Claude Code
- Codex
- Gemini
- GitHub Copilot
- Kiro
- Qwen
- Antigravity
- Z.AI GLM

## Architecture

BeitaProxy runs two local layers:

1. **ThinkingProxy** on port `8317`
   - Receives local client requests
   - Handles thinking-related model-name transformations for supported Claude flows
2. **CLIProxyAPI backend** on port `8318`
   - Forwards authenticated upstream requests
   - Serves the backend management page

```text
Client / IDE -> http://localhost:8317 -> http://localhost:8318 -> upstream AI service
```

## Requirements

- Node.js 18+
- `cli-proxy-api` in the project root
- `config.yaml` in the project root

For Windows packaging, `cli-proxy-api.exe` is also used.

## Quick Start

### Install dependencies

```bash
npm install
```

### Run in development mode

```bash
npm start
```

### Build

```bash
npm run build
```

Platform-specific builds:

```bash
npm run build:mac
npm run build:win
npm run build:linux
```

## Project Structure

```text
.
├── assets/
├── src/
│   └── main.js
├── ui/
│   └── settings.html
├── static/
├── config.yaml
├── cli-proxy-api
├── cli-proxy-api.exe
├── package.json
└── LICENSE
```

## Notes

- User auth data is stored under `~/.cli-proxy-api/`
- The settings window manages providers, accounts, proxy settings, and dashboard access
- The backend management page is typically available at `http://localhost:8318/management.html`

## License

Distributed under the MIT License. See [LICENSE](LICENSE).

---

# 中文说明

BeitaProxy 是一个基于 Electron 构建、并由 [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) 提供后端能力的桌面 AI 代理应用。

## 项目简介

BeitaProxy 为多个 AI 服务提供统一的本地代理入口，让 Cursor、Continue、Cline 等本地工具通过同一个地址完成连接。

它适合希望复用现有服务订阅、并通过桌面应用统一管理代理和账号的用户使用。

## 主要特性

- 基于 Electron 的桌面应用
- 面向 AI 工具的统一本地代理入口
- 内置设置和账号管理界面
- 支持已支持服务的 OAuth 登录接入
- 部分服务支持多账号管理
- 支持开机启动
- 支持本地代理配置
- 提供后端管理页 Dashboard 入口
- 支持 Claude 相关模型的 Extended Thinking 命名转换

## 支持的服务

- Claude Code
- Codex
- Gemini
- GitHub Copilot
- Kiro
- Qwen
- Antigravity
- Z.AI GLM

## 架构说明

BeitaProxy 在本地运行两层服务：

1. **ThinkingProxy**，端口 `8317`
   - 接收本地客户端请求
   - 对支持的 Claude 请求执行基于模型名的 thinking 转换
2. **CLIProxyAPI 后端**，端口 `8318`
   - 转发带认证信息的上游请求
   - 提供后端管理页面

```text
客户端 / IDE -> http://localhost:8317 -> http://localhost:8318 -> 上游 AI 服务
```

## 环境要求

- Node.js 18+
- 项目根目录中存在 `cli-proxy-api`
- 项目根目录中存在 `config.yaml`

Windows 打包时还会使用 `cli-proxy-api.exe`。

## 快速开始

### 安装依赖

```bash
npm install
```

### 启动开发模式

```bash
npm start
```

### 构建

```bash
npm run build
```

按平台构建：

```bash
npm run build:mac
npm run build:win
npm run build:linux
```

## 项目结构

```text
.
├── assets/
├── src/
│   └── main.js
├── ui/
│   └── settings.html
├── static/
├── config.yaml
├── cli-proxy-api
├── cli-proxy-api.exe
├── package.json
└── LICENSE
```

## 说明

- 用户认证数据保存在 `~/.cli-proxy-api/`
- 设置窗口可管理服务、账号、代理设置和 Dashboard 入口
- 后端管理页通常位于 `http://localhost:8318/management.html`

## 许可证

项目按 MIT License 分发，详见 [LICENSE](LICENSE)。
