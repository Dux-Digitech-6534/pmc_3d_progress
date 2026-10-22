// Minimal typing for the two node:fs calls the AI schema export test uses (the project has no @types/node).
declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function writeFileSync(path: string, data: string): void;
  export function existsSync(path: string): boolean;
}
declare const process: { env: Record<string, string | undefined> };
