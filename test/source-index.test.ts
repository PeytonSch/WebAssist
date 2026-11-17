import { mkdirSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { outerClass, SourceIndex } from '../src/server/source/index';
import { findProjectRoot, findProjects } from '../src/server/source/roots';
import { declarationLine, findSourceDirs, javaClassName, parseDeclarations } from '../src/server/source/scan';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dh-source-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Writes files given as { 'relative/path': content }. */
function files(base: string, map: Record<string, string>): void {
  for (const [rel, content] of Object.entries(map)) {
    const p = join(base, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
}

const java = (pkg: string, cls: string) => `package ${pkg};\n\npublic class ${cls} {\n  void run() {}\n}\n`;

describe('project roots', () => {
  it('walks up from a WAR build folder to the folder with the build file', async () => {
    files(dir, { 'shop/pom.xml': '<project/>', 'shop/target/shop.war': 'x' });
    expect(await findProjectRoot(join(dir, 'shop', 'target'))).toBe(join(dir, 'shop'));
  });

  it('prefers the outermost build file, for multi-module builds, and stops at .git', async () => {
    files(dir, {
      'pom.xml': '<project/>', // above the repository: must not be taken
      'repo/.git/HEAD': 'ref',
      'repo/settings.gradle.kts': '',
      'repo/web/build.gradle.kts': '',
      'repo/web/build/libs/web.war': 'x',
    });
    expect(await findProjectRoot(join(dir, 'repo', 'web', 'build', 'libs'))).toBe(join(dir, 'repo'));
  });

  it('gives up after a few levels and when there is no build file', async () => {
    files(dir, { 'a/pom.xml': '', 'a/b/c/d/e/f/target/x.war': '' });
    expect(await findProjectRoot(join(dir, 'a', 'b', 'c', 'd', 'e', 'f', 'target'))).toBeNull();
    files(dir, { 'plain/target/x.war': '' });
    expect(await findProjectRoot(join(dir, 'plain', 'target'))).toBeNull();
  });

  it('expands * patterns into several projects, survives mvn clean and adds source folders', async () => {
    files(dir, {
      'dev/shop/pom.xml': '',
      'dev/shop/target/shop-1.2.0.war': 'x',
      'dev/admin/pom.xml': '', // target deleted by mvn clean
      'dev/shopx/pom.xml': '', // a name that starts like shop
      'dev/shopx/target/shopx.war': 'x',
      'dev/notes/readme.txt': '',
      'libs/common/src/main/java/A.java': '',
    });
    const { projects, problems } = await findProjects([join(dir, 'dev', '*', 'target'), join(dir, 'dev', 'admin', 'target')], [join(dir, 'libs', 'common'), join(dir, 'missing')]);
    const roots = projects.map((p) => p.root).sort();
    expect(roots).toEqual([join(dir, 'dev', 'admin'), join(dir, 'dev', 'shop'), join(dir, 'dev', 'shopx'), join(dir, 'libs', 'common')].sort());
    const shop = projects.find((p) => p.root.endsWith('shop'))!;
    expect(shop.names.sort()).toEqual(['shop', 'shop-1.2.0']);
    expect(problems).toEqual([`Folder not found: ${join(dir, 'missing')}`]);
  });
});

describe('reading sources', () => {
  it('names Java classes by their path and finds source sets at any module depth', async () => {
    files(dir, {
      'pom.xml': '',
      'src/main/java/com/x/A.java': '',
      'core/src/main/kotlin/com/x/K.kt': '',
      'core/src/test/java/com/x/ATest.java': '',
      'apps/web/src/main/groovy/G.groovy': '',
      'node_modules/pkg/src/main/java/No.java': '',
      'target/src/main/java/No.java': '',
    });
    const dirs = await findSourceDirs(dir);
    expect(dirs.map((d) => [d.module, d.dir.slice(dir.length + 1).split(/[\\/]/).join('/')]).sort()).toEqual([
      ['', 'src/main/java'],
      ['apps/web', 'apps/web/src/main/groovy'],
      ['core', 'core/src/main/kotlin'],
      ['core', 'core/src/test/java'],
    ]);
    expect(javaClassName(join(dir, 'src/main/java'), join(dir, 'src/main/java/com/x/A.java'))).toBe('com.x.A');
  });

  it('reads Kotlin, Groovy and Scala packages and classes', () => {
    const kt = 'package com.example.orders\n\nimport x.Y\n\ndata class Order(val id: Long)\nsealed interface Event\nobject Registry {\n  class Nested\n}\nfun helper() = 1\nenum class State { A }\n';
    expect(parseDeclarations(kt, '/p/Orders.kt')).toEqual({ pkg: 'com.example.orders', classes: ['Order', 'Event', 'Registry', 'State', 'OrdersKt'] });
    expect(parseDeclarations('@file:JvmName("Util")\npackage a.b\nfun x() = 1\n', '/p/util.kt').classes).toEqual(['Util']);
    expect(parseDeclarations('println "hi"\n', '/p/Script.groovy')).toEqual({ pkg: '', classes: ['Script'] });
    expect(parseDeclarations('package a.b;\nclass G {}\ninterface H {}\n', '/p/G.groovy').classes).toEqual(['G', 'H']);
    expect(parseDeclarations('package a.b\ncase class P(x: Int)\nobject Main extends App\ntrait T\n', '/p/M.scala').classes).toEqual(['P', 'Main', 'T']);
  });

  it('finds the line a class is declared on', () => {
    expect(declarationLine('package a;\n\n/** doc */\npublic final class OrderService {\n}', 'OrderService')).toBe(4);
    expect(declarationLine('class Other {}', 'OrderService')).toBeNull();
  });

  it('maps inner, anonymous and lambda classes to their outer class', () => {
    expect(outerClass('com.x.Foo$Bar$1')).toBe('com.x.Foo');
    expect(outerClass('com.x.Foo$$Lambda/0x0000012')).toBe('com.x.Foo');
    expect(outerClass('com.x.Foo')).toBe('com.x.Foo');
  });
});

describe('SourceIndex', () => {
  const shop = () => join(dir, 'dev', 'shop');
  beforeEach(() => {
    files(dir, {
      'dev/shop/pom.xml': '',
      'dev/shop/target/shop.war': 'x',
      'dev/shop/src/main/java/com/example/orders/OrderService.java': java('com.example.orders', 'OrderService'),
      'dev/shop/src/main/java/com/example/orders/OrderController.java': java('com.example.orders', 'OrderController'),
      'dev/shop/src/main/java/com/example/orders/Helpers.java': 'package com.example.orders;\nclass Helpers {}\nclass Extra {}\n',
      'dev/shop/src/main/java/misplaced/Moved.java': 'package com.example.moved;\nclass Moved {}\n',
      'dev/shop/src/main/kotlin/com/example/k/Things.kt': 'package com.example.k\nclass Thing\nfun top() = 1\n',
      'dev/shop/src/main/java/com/example/orders/node_modules/No.java': '',
      'dev/admin/pom.xml': '',
      'dev/admin/target/admin-2.0.war': 'x',
      'dev/admin/src/main/java/com/example/orders/OrderService.java': java('com.example.orders', 'OrderService'),
    });
  });

  const build = async () => {
    const index = new SourceIndex([join(dir, 'dev', '*', 'target')], []);
    await index.build();
    return index;
  };

  it('finds classes by name, inner class, JUL class.method and shortened logger name', async () => {
    const index = await build();
    const st = index.status();
    expect(st.projects.map((p) => [p.name, p.classes]).sort()).toEqual([['admin', 1], ['shop', 6]]);
    expect(Object.keys(index.known(['com.example.orders.OrderController', 'com.example.orders.OrderController$1', 'com.example.orders.OrderController.getOrder', 'c.e.o.OrderController', 'com.example.k.ThingsKt', 'org.apache.Nope', 'com.example.orders.No']))).toEqual([
      'com.example.orders.OrderController',
      'com.example.orders.OrderController$1',
      'com.example.orders.OrderController.getOrder',
      'c.e.o.OrderController',
      'com.example.k.ThingsKt',
    ]);
    const [c] = await index.resolve('com.example.orders.OrderController$Inner', { file: 'OrderController.java', line: 42 });
    expect(c).toMatchObject({ file: join(shop(), 'src/main/java/com/example/orders/OrderController.java'), line: 42, project: 'shop', module: '' });
  });

  it('uses the file name a frame gives for a second class in another file', async () => {
    const index = await build();
    // com.example.orders.Extra is compiled from Helpers.java: the frame says so.
    const hits = await index.resolve('com.example.orders.Helpers', { file: 'Helpers.java' });
    expect(hits.map((h) => h.file)).toEqual([join(shop(), 'src/main/java/com/example/orders/Helpers.java')]);
  });

  it('checks the package line of a Java file in the wrong folder', async () => {
    const index = await build();
    expect(index.known(['com.example.moved.Moved'])).toEqual({});
    const hits = await index.resolve('com.example.moved.Moved');
    expect(hits.map((h) => h.file)).toEqual([join(shop(), 'src/main/java/misplaced/Moved.java')]);
  });

  it('picks the project the webapp was built from, else returns every candidate', async () => {
    const index = await build();
    const name = 'com.example.orders.OrderService';
    expect((await index.resolve(name)).map((c) => c.project).sort()).toEqual(['admin', 'shop']);
    expect((await index.resolve(name, { webapp: 'shop' })).map((c) => c.project)).toEqual(['shop']);
    // admin-2.0.war deploys as "admin" (version stripped) or as admin-2.0.
    expect((await index.resolve(name, { webapp: 'admin' })).map((c) => c.project)).toEqual(['admin']);
    expect((await index.resolve(name, { webapp: 'admin-2.0##3' })).map((c) => c.project)).toEqual(['admin']);
    expect((await index.resolve(name, { webapp: 'other' })).length).toBe(2);
    expect(index.known([name])).toEqual({ [name]: 2 });
    expect(index.known([name], 'shop')).toEqual({ [name]: 1 });
  });

  it('picks up added and removed files on refresh', async () => {
    const index = await build();
    const gen = index.generation;
    const pkg = join(shop(), 'src/main/java/com/example/orders');
    writeFileSync(join(pkg, 'NewThing.java'), java('com.example.orders', 'NewThing'));
    unlinkSync(join(pkg, 'OrderController.java'));
    // Folder times have a coarse resolution on some file systems; make the change visible.
    utimesSync(pkg, new Date(), new Date(Date.now() + 5000));
    await index.refresh();
    expect(index.known(['com.example.orders.NewThing', 'com.example.orders.OrderController'])).toEqual({ 'com.example.orders.NewThing': 1 });
    expect(index.generation).toBeGreaterThan(gen);
  });

  it('indexes a few thousand files quickly', async () => {
    const base = join(dir, 'big');
    const map: Record<string, string> = { 'pom.xml': '' };
    for (let m = 0; m < 4; m++) {
      for (let p = 0; p < 25; p++) {
        for (let c = 0; c < 40; c++) map[`mod${m}/src/main/java/com/big/m${m}/p${p}/C${c}.java`] = '';
      }
    }
    files(base, map);
    const index = new SourceIndex([], [base]);
    const t0 = Date.now();
    await index.build();
    const ms = Date.now() - t0;
    expect(index.status().files).toBe(4000);
    expect(index.status().projects[0].modules.sort()).toEqual(['mod0', 'mod1', 'mod2', 'mod3']);
    expect(ms).toBeLessThan(5000);
    const t1 = Date.now();
    const names = Array.from({ length: 1000 }, (_, i) => `com.big.m${i % 4}.p${Math.floor(i / 40) % 25}.C${i % 40}`);
    expect(Object.keys(index.known(names)).length).toBe(new Set(names).size);
    expect(Date.now() - t1).toBeLessThan(200);
  });

  it('caps the number of files and says so', async () => {
    const index = new SourceIndex([join(dir, 'dev', '*', 'target')], [], { maxFiles: 3 });
    await index.build();
    expect(index.status().files).toBe(3);
    expect(index.status().truncated).toBe(true);
    expect(index.status().problems.join(' ')).toMatch(/Stopped after 3 source files/);
  });
});
