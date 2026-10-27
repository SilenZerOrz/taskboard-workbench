// 与 node --import 搭配：注册同目录的 loader.mjs
import { register } from "node:module";
register(new URL("./loader.mjs", import.meta.url).href);
