import { relative, resolve } from 'node:path';
import { createProject } from '../project.js';
import { detail, heading, line, note, success } from '../ui.js';

export interface InitArgs {
  directory?: string;
  title?: string;
  type?: string;
}

export function runInit(args: InitArgs): number {
  const root = resolve(args.directory ?? '.');
  const store = createProject(root, {
    ...(args.title ? { title: args.title } : {}),
    ...(args.type ? { type: args.type } : {}),
  });
  const project = store.readProject();

  success(`created ${project.title}`);
  heading('where things are');
  detail('project', relative(process.cwd(), store.paths.dir) || store.paths.dir);
  detail('background', relative(process.cwd(), store.paths.context) || store.paths.context);

  heading('next');
  line('  1. oea ingest ./footage        register your media');
  line('  2. edit .oea/context.yaml      tell it what the footage cannot say');
  line('  3. oea analyze                 build the Editorial IR');
  line('  4. oea plan --skill travel-vlog --duration 180');
  line();
  note('Step 2 is the one that matters. An occasion written there changes which');
  note('moments the edit thinks are important.');
  return 0;
}
