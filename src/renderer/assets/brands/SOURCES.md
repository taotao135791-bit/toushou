# 官方品牌图标来源

核验与获取日期：2026-11-04。仅用于识别已接入服务，不表示合作、赞助或认证。商标及图形权利归各品牌所有；这些文件不改变项目其它源码的许可。

图像均从品牌官网或官网引用的官方 CDN 获取，本地打包；运行时不向第三方图标库发送账户、查询或页面地址。未手绘、重配色或拉伸图形。

动态网站图标不属于本目录的静态品牌资源。一般网站优先从经过公网 DNS 校验并固定地址的源站 `/favicon.ico` 获取；GitHub 在代理 fake-IP 等源站路径不可用时，可从 [GitHub 官方 PNG favicon 常量](https://github.githubassets.com/favicons/favicon.png) 补取。已匿名核验 [GitHub 官网](https://github.com/) HTML 将该 URL 声明为 `alternate icon`、类型为 PNG；真实获取返回 200、无重定向、32×32 RGBA PNG。固定补取仅接受 `github.com`、`www.github.com` 两个明确映射，请求 URL 不包含调用方域名、子域、页面路径或查询参数；不转发 Cookie、账户数据或凭据，不使用第三方图标服务。独立非持久网络会话保留 TLS 验证、禁止重定向及图像格式、体积与尺寸边界。网站图标只用于识别来源，不证明网站身份或当前内容。

| 文件 | 品牌 | 来源页 | 资源直链 | 说明 |
| --- | --- | --- | --- | --- |
| facebook.png / facebook.ico | Facebook | [官网](https://www.facebook.com/) | [官方资源](https://static.xx.fbcdn.net/rsrc.php/y1/r/ay1hV6OlegS.ico) | 官网 shortcut icon；保留 ICO 原件，以系统图像工具仅转换容器格式为 PNG，无重绘或改色。 |
| tiktok.png | TikTok | [官网](https://developers.tiktok.com/docs/en/getting-started-design-guidelines) | [官方资源](https://lf16-tiktok-common.ttwstatic.com/obj/tiktok-web-common-sg/mtact/static/images/logo_144c91a.png?v=2) | 官方开发者站点的 icon 链接，文件未修改。 |
| feishu.png | 飞书 / Lark | [官网](https://www.feishu.cn/) | [官方资源](https://p16-hera-overseas.larksuitecdn.com/tos-mya-i-lojyj5t9n9/9b87226605154fb7b8141a9c94de22e9.png~tplv-lojyj5t9n9-origin.image) | 官网在当前地区跳转到 Lark；使用其官方 CDN icon，保留完整彩色鸟标。 |
| figma.svg | Figma | [官网](https://www.figma.com/) | [官方资源](https://static.figma.com/app/icon/2/favicon.svg) | 官网声明的 SVG icon，文件未修改。 |
| google-ads.svg | Google Ads | [官网](https://business.google.com/us/google-ads/) | [官方资源](https://www.gstatic.com/images/branding/productlogos/ads/v5/192px.svg) | Google Ads 官网产品图标引用，文件未修改；仅用于 Google Ads，不代表其它 Google 产品。 |
| appsflyer.png | AppsFlyer | [官网](https://www.appsflyer.com/) | [官方资源](https://www.appsflyer.com/wp-content/uploads/2025/11/cropped-54649.-New-Website-favicon-192x192.png) | 官方站点公开的 WordPress favicon，下载原件未修改。 |

Facebook 图形使用参考：[Meta 官方 Facebook Logo 页面](https://www.meta.com/brand/resources/facebook/logo/)。TikTok 资源说明参考：[官方 Design Guidelines](https://developers.tiktok.com/docs/en/getting-started-design-guidelines)。图标在固定尺寸的独立区域中显示，保留原始比例与周围间距。

## SHA-256

```text
4bbf46a94e73ca973e8e2092caa49616f6d911d26792a1351c63eaa198fb79e5  appsflyer.png
8924f44d76426a340b105cbdc5b93678c6b772e847b393f2568d94847c0d8d80  facebook.ico
bc1151d22d5ab16968aa2efe7edaa1ed0176d31d23bea5032e3cdf5552269bc5  facebook.png
a99925e6db13b5a72c64dde7ec4d9b63b8af6d84ec2e5fd2e7c975d00a519c3c  feishu.png
e6227b7dbc49c86da6f4ccfa02ba439428106b0ca627a0a33ea6ad1e09f335b3  figma.svg
69b023ff2ac2e7e72777701822b842f66128a41cd2035188c89ce45e940eb7bc  google-ads.svg
5e9c735171956561f39711ea2c6b593ad1d288e53cad060237d0f986202ffb36  tiktok.png
```
