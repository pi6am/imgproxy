import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { configSchema, formatZodError, type AppConfig } from "./schema.js";

export class ConfigError extends Error {}

export class ConfigStore {
  private config: AppConfig;

  constructor(readonly file: string) {
    this.config = loadConfig(file);
  }

  get(): AppConfig {
    return this.config;
  }

  update(input: unknown): AppConfig {
    let parsed: AppConfig;
    try {
      parsed = configSchema.parse(input);
    } catch (err) {
      if (err instanceof z.ZodError) throw new ConfigError(`Invalid config: ${formatZodError(err)}`);
      throw err;
    }
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(parsed, null, 2));
    fs.renameSync(tmp, this.file);
    this.config = parsed;
    return parsed;
  }
}

function loadConfig(file: string): AppConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return configSchema.parse({});
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`Config file ${file} is not valid JSON: ${(err as Error).message}`);
  }
  const result = configSchema.safeParse(json);
  if (!result.success) {
    throw new ConfigError(`Config file ${file} is invalid: ${formatZodError(result.error)}`);
  }
  return result.data;
}
