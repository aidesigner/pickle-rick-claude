import { existsSync, readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';

export type ProjectShape = 'node-cli' | 'react-frontend' | 'nestjs-api' | 'python' | 'rust' | 'unknown';

interface PackageJson {
  bin?: unknown;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function readPackageJson(repoRoot: string): PackageJson | null {
  const pkgPath = path.join(repoRoot, 'package.json');
  if (!existsSync(pkgPath)) return null;
  try {
    return JSON.parse(readFileSync(pkgPath, 'utf-8')) as PackageJson;
  } catch {
    return null;
  }
}

function allDeps(pkg: PackageJson): string[] {
  return [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ];
}

function hasSrcTsx(repoRoot: string): boolean {
  const srcDir = path.join(repoRoot, 'src');
  if (!existsSync(srcDir)) return false;
  try {
    return readdirSync(srcDir).some((f) => f.endsWith('.tsx'));
  } catch {
    return false;
  }
}

interface ShapeSignals {
  has: (f: string) => boolean;
  pkg: PackageJson | null;
  deps: string[];
}

function isNodeCli({ pkg, deps }: ShapeSignals): boolean {
  if (!pkg || pkg.bin === undefined) return false;
  return !deps.some((d) => d === 'next' || d === '@nestjs/core' || d.startsWith('@nestjs/'));
}

function isReactFrontend({ has, deps }: ShapeSignals, repoRoot: string): boolean {
  return deps.some((d) => d === 'react' || d === 'next')
    || has('next.config.js')
    || has('next.config.ts')
    || hasSrcTsx(repoRoot);
}

function isNestJsApi({ deps }: ShapeSignals): boolean {
  return deps.some((d) => d === '@nestjs/core' || d.startsWith('@nestjs/'));
}

function isPython({ has }: ShapeSignals): boolean {
  return has('requirements.txt') || has('pyproject.toml');
}

function isRust({ has }: ShapeSignals): boolean {
  return has('Cargo.toml');
}

export function detectProjectShapes(repoRoot: string): ProjectShape[] {
  const pkg = readPackageJson(repoRoot);
  const signals: ShapeSignals = {
    has: (f) => existsSync(path.join(repoRoot, f)),
    pkg,
    deps: pkg ? allDeps(pkg) : [],
  };

  const shapes: ProjectShape[] = [];
  if (isNodeCli(signals)) shapes.push('node-cli');
  if (isReactFrontend(signals, repoRoot)) shapes.push('react-frontend');
  if (isNestJsApi(signals)) shapes.push('nestjs-api');
  if (isPython(signals)) shapes.push('python');
  if (isRust(signals)) shapes.push('rust');

  return shapes.length > 0 ? shapes : ['unknown'];
}
