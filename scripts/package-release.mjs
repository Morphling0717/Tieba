import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { deflateRawSync } from "node:zlib";

const projectRoot = path.resolve(import.meta.dirname, "..");
const distRoot = path.join(projectRoot, "dist");
const releaseRoot = path.join(projectRoot, "release");
const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
const packageLock = JSON.parse(await readFile(path.join(projectRoot, "package-lock.json"), "utf8"));
const sourceManifest = JSON.parse(await readFile(path.join(projectRoot, "public", "manifest.json"), "utf8"));
const manifest = JSON.parse(await readFile(path.join(distRoot, "manifest.json"), "utf8"));

const declaredVersions = {
  "package.json": packageJson.version,
  "package-lock.json": packageLock.version,
  "package-lock.json#packages[\"\"]": packageLock.packages?.[""]?.version,
  "public/manifest.json": sourceManifest.version,
  "dist/manifest.json": manifest.version,
};
for (const [source, version] of Object.entries(declaredVersions)) {
  if (version !== packageJson.version) {
    throw new Error(`Version mismatch: package.json=${packageJson.version}, ${source}=${version}`);
  }
}
const versionParts = String(packageJson.version).split(".");
if (
  !/^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){0,3}$/u.test(packageJson.version)
  || versionParts.some((part) => Number(part) > 65_535)
  || versionParts.every((part) => Number(part) === 0)
) {
  throw new Error(`Invalid Chrome extension version: ${packageJson.version}`);
}
if (manifest.manifest_version !== 3) {
  throw new Error(`Unsupported manifest version: ${manifest.manifest_version}`);
}

const requiredFiles = new Set([
  "background.js",
  "content.js",
  "manifest.json",
  "sidepanel.html",
  "sidepanel.js",
]);

const allowedFile = (relativePath) => {
  if (requiredFiles.has(relativePath)) return true;
  return /^assets\/[A-Za-z0-9._-]+\.(?:css|js)$/u.test(relativePath);
};

async function listFiles(directory, prefix = "") {
  const result = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...await listFiles(absolutePath, relativePath));
    } else if (entry.isFile() && !relativePath.endsWith(".map")) {
      result.push({ absolutePath, relativePath });
    }
  }
  return result;
}

const files = await listFiles(distRoot);
if (files.length >= 0xffff) throw new Error("Too many files for a non-ZIP64 release archive");
const actualPaths = new Set(files.map(({ relativePath }) => relativePath));
for (const requiredFile of requiredFiles) {
  if (!actualPaths.has(requiredFile)) throw new Error(`Missing release file: ${requiredFile}`);
}
for (const { relativePath } of files) {
  if (!allowedFile(relativePath)) throw new Error(`Unexpected release file: ${relativePath}`);
  if (relativePath.includes("..") || path.isAbsolute(relativePath)) {
    throw new Error(`Unsafe release path: ${relativePath}`);
  }
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) !== 0 ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  }
  return value >>> 0;
});

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function localHeader(name, data, compressed) {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0800, 6);
  header.writeUInt16LE(8, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(33, 12); // 1980-01-01, fixed for reproducible archives.
  header.writeUInt32LE(crc32(data), 14);
  header.writeUInt32LE(compressed.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(name.length, 26);
  header.writeUInt16LE(0, 28);
  return header;
}

function centralHeader(name, data, compressed, localOffset) {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(0x0314, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x0800, 8);
  header.writeUInt16LE(8, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt16LE(33, 14);
  header.writeUInt32LE(crc32(data), 16);
  header.writeUInt32LE(compressed.length, 20);
  header.writeUInt32LE(data.length, 24);
  header.writeUInt16LE(name.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(0, 38);
  header.writeUInt32LE(localOffset, 42);
  return header;
}

const localParts = [];
const centralParts = [];
const packagedFiles = [];
let localOffset = 0;

for (const file of files.sort((left, right) => left.relativePath.localeCompare(right.relativePath, "en"))) {
  const name = Buffer.from(file.relativePath, "utf8");
  const data = await readFile(file.absolutePath);
  const compressed = deflateRawSync(data, { level: 9 });
  if (name.length >= 0xffff || data.length >= 0xffffffff || compressed.length >= 0xffffffff) {
    throw new Error(`Release file exceeds classic ZIP limits: ${file.relativePath}`);
  }
  const local = localHeader(name, data, compressed);
  localParts.push(local, name, compressed);
  centralParts.push(centralHeader(name, data, compressed, localOffset), name);
  localOffset += local.length + name.length + compressed.length;
  packagedFiles.push({ path: file.relativePath, bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") });
}

const centralDirectory = Buffer.concat(centralParts);
if (
  localOffset >= 0xffffffff
  || centralDirectory.length >= 0xffffffff
  || localOffset + centralDirectory.length + 22 >= 0xffffffff
) {
  throw new Error("Release archive exceeds classic ZIP layout limits");
}
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(0, 4);
end.writeUInt16LE(0, 6);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralDirectory.length, 12);
end.writeUInt32LE(localOffset, 16);
end.writeUInt16LE(0, 20);

const archive = Buffer.concat([...localParts, centralDirectory, end]);
const archiveName = `tieba-long-thread-review-assistant-${manifest.version}.zip`;
const archivePath = path.join(releaseRoot, archiveName);
const archiveSha256 = createHash("sha256").update(archive).digest("hex");
const lockSha256 = createHash("sha256").update(await readFile(path.join(projectRoot, "package-lock.json"))).digest("hex");

let sourceCommit = null;
let sourceDirty = null;
try {
  sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8" }).trim();
  sourceDirty = execFileSync("git", ["status", "--porcelain"], { cwd: projectRoot, encoding: "utf8" }).trim().length > 0;
} catch {
  // Packaging is also supported from a source archive without Git metadata.
}

await mkdir(releaseRoot, { recursive: true });
await rm(archivePath, { force: true });
await writeFile(archivePath, archive);
await writeFile(`${archivePath}.sha256`, `${archiveSha256}  ${archiveName}\n`, "utf8");
await writeFile(path.join(releaseRoot, `release-manifest-${manifest.version}.json`), `${JSON.stringify({
  schemaVersion: 1,
  version: manifest.version,
  archive: archiveName,
  archiveSha256,
  packageLockSha256: lockSha256,
  sourceCommit,
  sourceDirty,
  node: process.version,
  sourceMapsIncluded: false,
  files: packagedFiles,
}, null, 2)}\n`, "utf8");

const archiveStats = await stat(archivePath);
console.log(`Created ${path.relative(projectRoot, archivePath)} (${archiveStats.size} bytes)`);
console.log(`SHA-256 ${archiveSha256}`);
