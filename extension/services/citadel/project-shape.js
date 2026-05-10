import { existsSync, readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
function readPackageJson(repoRoot) {
    const pkgPath = path.join(repoRoot, 'package.json');
    if (!existsSync(pkgPath))
        return null;
    try {
        return JSON.parse(readFileSync(pkgPath, 'utf-8'));
    }
    catch {
        return null;
    }
}
function allDeps(pkg) {
    return [
        ...Object.keys(pkg.dependencies ?? {}),
        ...Object.keys(pkg.devDependencies ?? {}),
    ];
}
function hasSrcTsx(repoRoot) {
    const srcDir = path.join(repoRoot, 'src');
    if (!existsSync(srcDir))
        return false;
    try {
        return readdirSync(srcDir).some((f) => f.endsWith('.tsx'));
    }
    catch {
        return false;
    }
}
function isNodeCli({ pkg, deps }) {
    if (!pkg || pkg.bin === undefined)
        return false;
    return !deps.some((d) => d === 'next' || d === '@nestjs/core' || d.startsWith('@nestjs/'));
}
function isReactFrontend({ has, deps }, repoRoot) {
    return deps.some((d) => d === 'react' || d === 'next')
        || has('next.config.js')
        || has('next.config.ts')
        || hasSrcTsx(repoRoot);
}
function isNestJsApi({ deps }) {
    return deps.some((d) => d === '@nestjs/core' || d.startsWith('@nestjs/'));
}
function isPython({ has }) {
    return has('requirements.txt') || has('pyproject.toml');
}
function isRust({ has }) {
    return has('Cargo.toml');
}
export function detectProjectShapes(repoRoot) {
    const pkg = readPackageJson(repoRoot);
    const signals = {
        has: (f) => existsSync(path.join(repoRoot, f)),
        pkg,
        deps: pkg ? allDeps(pkg) : [],
    };
    const shapes = [];
    if (isNodeCli(signals))
        shapes.push('node-cli');
    if (isReactFrontend(signals, repoRoot))
        shapes.push('react-frontend');
    if (isNestJsApi(signals))
        shapes.push('nestjs-api');
    if (isPython(signals))
        shapes.push('python');
    if (isRust(signals))
        shapes.push('rust');
    return shapes.length > 0 ? shapes : ['unknown'];
}
