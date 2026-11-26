import { register } from "node:module";
import process from "node:process";

register(new URL("./dev-server-loader.mjs", import.meta.url), {
  data: {
    sourceDir: process.env.HIVE_DEV_SERVER_SOURCE,
    outputDir: process.env.HIVE_DEV_SERVER_OUTPUT,
  },
});
