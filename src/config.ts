import { readFileSync, mkdirSync, lstatSync, chmodSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";

export const chatIdSchema = z
  .string()
  .regex(/^[0-9]+(?:-[0-9]+)?@(?:s\.whatsapp\.net|g\.us|lid)$/);
const schema = z
  .object({
    dataDir: z.string().min(1),
    access: z.enum(["selected", "account"]).default("selected"),
    allowedChats: z.array(chatIdSchema).max(500),
    cacheMedia: z.boolean().default(false),
    maxMediaBytes: z
      .number()
      .int()
      .min(1)
      .max(4 * 1024 * 1024)
      .default(4 * 1024 * 1024),
  })
  .strict();
export type Config = z.infer<typeof schema>;
export type Policy = () => Config;

/** Read for every operation: malformed or removed configuration fails closed. */
export function configPolicy(path: string): Policy {
  const absolute = resolve(path);
  let fixedDataDir: string | undefined;
  return () => {
    const config = schema.parse(JSON.parse(readFileSync(absolute, "utf8")));
    const dataDir = resolve(dirname(absolute), config.dataDir);
    if (fixedDataDir && fixedDataDir !== dataDir)
      throw new Error("Data directory changed; restart to use the new archive");
    fixedDataDir = dataDir;
    return { ...config, dataDir };
  };
}

export function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("Data directory must be a real private directory");
  chmodSync(path, 0o700);
}

export function chatAllowed(config: Config, chatId: string): boolean {
  return (
    chatIdSchema.safeParse(chatId).success &&
    (config.access === "account" || config.allowedChats.includes(chatId))
  );
}
