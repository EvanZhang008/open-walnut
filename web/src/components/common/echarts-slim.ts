/**
 * The part of ECharts that slide previews use, standing in for `echarts` when pptx-preview imports
 * it (web/bundle-trim.ts). pptx-preview draws a slide's chart with `init(el, null, { renderer:
 * 'svg' })` and an option of bar, line (area too) or pie (doughnut too) series with a title, legend
 * and tooltip. The whole library is about 550 modules the build would otherwise read.
 * A chart kind pptx-preview learns later must be registered here: tests/web/bundle-trim.test.ts
 * reads the series types and renderer out of pptx-preview and fails on one that is missing.
 */
// Each registers itself with the same registry as `echarts/core`. Deep files, not the
// `echarts/charts` and `echarts/components` lists: the build reads every module such a list names.
import 'echarts/lib/chart/bar.js';
import 'echarts/lib/chart/line.js';
import 'echarts/lib/chart/pie.js';
import 'echarts/lib/component/grid.js';
import 'echarts/lib/component/legend.js';
import 'echarts/lib/component/title.js';
import 'echarts/lib/component/tooltip.js';
import { use } from 'echarts/core';
import { SVGRenderer } from 'echarts/renderers';

use([SVGRenderer]);

export * from 'echarts/core';
