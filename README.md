# Cyber Nanning

基于 **OpenStreetMap 真实数据** 的南宁 3D 城市漫游游戏（Three.js + TypeScript + Vite）。
地图范围：北至民族大道、南至越秀路，西起竹溪大道、东至桂雅路，覆盖 **东盟商务区**、**石门森林公园**、**南宁国际会展中心** 及周边道路与建筑。

画面风格：赛博朋克夜景（霓虹屋顶轮廓、程序化窗格灯光、发光车道线、路灯光晕、Bloom 辉光），可按 `T` 切换到白天模式。

## 运行

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # 类型检查 + 生产构建到 dist/
npm run preview    # 预览生产构建
npm test           # 碰撞与地图数据测试 (vitest)
```

## 操作

| 按键 | 功能 |
| --- | --- |
| `W` `A` `S` `D` / 方向键 | 移动（相对镜头方向） |
| `Shift` | 奔跑 |
| `Space` | 跳跃 |
| 鼠标 / `Q` `E` | 旋转视角（点击画面锁定鼠标，`Esc` 释放） |
| 滚轮 | 镜头远近 |
| `1` `2` `3` `4` | 传送：万象城 / 会展中心朱槿花穹顶 / 石门森林公园明湖 / 东盟商务区三祺广场 |
| `F` | 自由视角（无碰撞飞行：`WASD` 沿视线飞行，`E`/`Space` 上升，`Q`/`C` 下降，`Shift` 加速，滚轮调巡航速度，`G` 降落到镜头下方，再按 `F` 返回角色） |
| `M` | 全图 |
| `T` | 昼夜切换 |
| `B` | 画质切换（高 / 中 / 低） |
| `H` | 隐藏操作提示 |

## 部署到 Vercel

项目已包含 `vercel.json`（framework: vite，输出目录 `dist`，静态资源长缓存）。

```bash
npx vercel          # 预览部署
npx vercel --prod   # 正式部署
```

或把仓库推到 GitHub 后在 Vercel 控制台导入，保持默认设置即可。构建不需要联网获取地图，数据已预处理在 `public/data/nanning.json`。

## 地图数据管线

```
scripts/area.mjs        地图范围 (bbox) 与投影原点
scripts/fetch-osm.mjs   从 Overpass API 下载原始 OSM 数据 → data/osm-raw.json（多镜像 + 指数退避重试）
scripts/build-map.mjs   转换为游戏用的紧凑 JSON → public/data/nanning.json
```

更新数据：`npm run fetch-osm && npm run build-map`。

`build-map` 做的事：

- 经纬度投影为以区域中心为原点的米制坐标（x 向东，z 向南）。
- 建筑：读取 `height` / `building:levels`（如南宁华润大厦 402.7 m、三祺广场 235 m），无高度的按类型估算。
- **程序化补全**：OSM 在这一带只标注了约 260 栋建筑，因此在已命名的住宅小区、商业用地、机关学校用地内，按小区走向自动排布塔楼/板楼（避开道路、绿地、水体和已有建筑）。东盟商务区核心的商业地块生成更高的写字楼。
- 道路按等级生成宽度与车道线；公园、林地、草地、水体、广场等转为地块；树木按地块类型撒点，主干道两侧生成棕榈行道树与路灯。

## 结构

```
src/
  main.ts               启动、渲染循环、后期处理、昼夜、自适应画质
  core/Collision.ts     2.5D 碰撞（建筑轮廓挤出 + 湖面），角色圆柱体推出、镜头防穿墙
  core/Input.ts         键盘 / Pointer Lock 鼠标
  world/City.ts         合并网格：地面、地块、道路、建筑、实例化树木与路灯、地标装饰
  world/materials.ts    着色器：程序化窗户与霓虹、道路标线、水面、网格地面、天空
  player/               角色模型与程序化动画、控制器、第三人称镜头
  ui/                   小地图 / 全图、地标标签、位置识别
```

## 性能

- 全城合并为少量网格：整帧约 50 次 draw call（含 Bloom），树木与路灯用 InstancedMesh。
- 平铺图层（地面/地块/道路）按绘制顺序叠放且不写深度，避免远处 z-fighting，也省去多边形偏移。
- 窗户、标线全部在着色器中程序化生成，没有贴图下载；地图 JSON 约 700 KB（gzip 后更小）。
- 自适应画质：持续低于 48 FPS 时自动降低像素比并关闭 Bloom；`B` 键手动切换。

## 数据许可

地图数据 © OpenStreetMap contributors，依据 [ODbL](https://opendatacommons.org/licenses/odbl/) 授权。部分建筑为程序化生成，并非真实测绘。
