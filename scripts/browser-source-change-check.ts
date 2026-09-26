import { ProjectService } from '../purecut/lib/projects';
import { applyReviewedSource } from '../purecut/source-change';
import type { ProjectFiles } from '../purecut/lib/platform-files';

export async function checkSourceChanges() {
  const files = new Map<string, string>();
  let fail = false;
  const fs = {
    root: async () => '/review',
    read: async (path: string) => {
      const value = files.get(path);
      if (value === undefined) throw Error('Missing fixture file');
      return value;
    },
    write: async (path: string, value: string) => {
      if (fail) throw Error('Fixture disk failure');
      files.set(path, value);
    },
  } as ProjectFiles;
  const service = new ProjectService(fs);
  await service.init();
  const project = await service.call('projects:create', {});
  await service.call('projects:compile', { dir: project.dir });
  const original = await service.readSource(project.dir);
  const proposal = await service.call('purecut:prepare', {
    dir: project.dir, baseHash: original.hash,
    source: original.source.replace('Welcome to PureCut', 'Reviewed title'),
  });
  const check = (value: unknown, message: string) => { if (!value) throw Error(message); };
  const reject = async (action: () => Promise<unknown>, match: RegExp) => {
    try { await action(); } catch (error) {
      check(match.test(String(error)), `Unexpected rejection: ${error}`); return;
    }
    throw Error('Expected source change rejection');
  };
  let openDir = project.dir;
  let held: (() => void) | undefined;
  let hold = false;
  const change = await applyReviewedSource(proposal, async edit => {
    if (openDir !== edit.dir) throw Error('Wrong project');
    if (hold) await new Promise<void>(resolve => { held = resolve; });
    return service.call('purecut:replace', edit);
  });
  check(change.isApplied() && (await service.readSource(project.dir)).hash === proposal.hash, 'reviewed edit applied');
  fail = true;
  await reject(() => change.reverse(), /disk failure/);
  check(change.isApplied() && (await service.readSource(project.dir)).hash === proposal.hash, 'failed undo retains saved source and direction');
  fail = false;
  hold = true;
  const pending = change.reverse();
  await reject(() => change.reverse(), /still saving/);
  held!(); hold = false;
  await pending;
  check(!change.isApplied() && (await service.readSource(project.dir)).source === original.source, 'one undo restores the entire original source');
  await change.reverse();
  check(change.isApplied() && (await service.readSource(project.dir)).hash === proposal.hash, 'redo restores exactly the reviewed source');
  openDir = '/another.cut';
  await reject(() => change.reverse(), /Wrong project/);
  openDir = project.dir;
  const latest = await service.readSource(project.dir);
  await service.call('purecut:replace', {
    dir: project.dir, source: latest.source.replace('Reviewed title', 'Newer manual change'), baseHash: latest.hash,
  });
  await reject(() => change.reverse(), /changed/);
  check((await service.readSource(project.dir)).source.includes('Newer manual change'), 'undo cannot overwrite a newer saved revision');
}
