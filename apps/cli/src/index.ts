import process from "node:process";
import { main } from "./main.ts";

const { code, output } = main(process.argv.slice(2));

process.stdout.write(`${output}\n`);
process.exitCode = code;
