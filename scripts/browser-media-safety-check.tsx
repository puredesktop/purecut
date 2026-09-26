import { AssetLibrary, type ProjectFS } from '@diffusionstudio/assets';
import { createRuntimeWorld, Library } from '@diffusionstudio/runtime';
import { WorldProvider } from '@diffusionstudio/koota-solid';
import { render } from 'solid-js/web';
import { PromptInputProvider } from '../apps/web/src/context/prompt-input';
import { Assets } from '../apps/web/src/components/sidebar-left/assets';
import { AssetInfoPreview } from '../apps/web/src/components/sidebar-right/inspector/asset-info-preview';
import { AssetSelection } from '../apps/web/src/engine/traits';

export async function checkMediaSafety() {
  const files = new Map<string, File>();
  const fs: ProjectFS = {
    readManifest: async () => null, writeManifest: async () => {}, list: async () => [],
    stat: async path => { const file = files.get(path); return file ? { size: file.size, mtime: file.lastModified } : null; },
    file: async path => { const file = files.get(path); if (!file) throw Error('Missing fixture'); return file; },
    write: async (path, blob) => { files.set(path, new File([blob], path.split('/').pop()!, { type: blob.type })); },
    remove: async path => { files.delete(path); },
  };
  const library = new AssetLibrary(fs);
  const world = createRuntimeWorld('media-safety');
  world.add(AssetSelection);
  world.set(Library, library);
  const host = document.createElement('div'); document.body.append(host);
  let dispose = () => {};
  const until = async (condition: () => boolean) => {
    for (let i = 0; i < 200; i++) {
      if (condition()) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw Error(`Media safety check timed out: ${host.textContent}; focus=${document.activeElement?.outerHTML.slice(0, 500)}; roles=${[...host.querySelectorAll('[role]')].map(el => el.getAttribute('role')).join(',')}`);
  };
  try {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 16;
    const blob = await new Promise<Blob>(resolve => canvas.toBlob(value => resolve(value!), 'image/png'));
    const asset = await library.store(blob, { name: 'safe.png' });
    dispose = render(() => <WorldProvider world={world}><AssetInfoPreview asset={asset} /></WorldProvider>, host);
    await until(() => !!host.querySelector('img')?.src);
    const oldUrl = host.querySelector('img')!.src;
    const recovered = await library.relinkFile(asset, files.get(asset.source)!);
    if (recovered !== asset) throw Error('Fixture must exercise same-object relinking');
    await until(() => !!host.querySelector('img')?.src && host.querySelector('img')!.src !== oldUrl);
    let revoked = false;
    try { await fetch(oldUrl); } catch { revoked = true; }
    if (!revoked) throw Error('Relinking must release the stale preview URL');
    dispose();
    dispose = render(() => <WorldProvider world={world}><PromptInputProvider><Assets /></PromptInputProvider></WorldProvider>, host);
    await until(() => !!host.querySelector('[data-asset-id]'));
    const selectAndDelete = () => {
      (host.querySelector('[data-asset-id]') as HTMLElement).click();
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }));
    };
    selectAndDelete();
    await until(() => !!document.querySelector('[role="alertdialog"]'));
    if (!files.has(asset.source) || !library.get(asset.id)) throw Error('Delete must not remove bytes before confirmation');
    await until(() => document.activeElement?.textContent === 'Cancel');
    (document.activeElement as HTMLElement).click();
    await until(() => !document.querySelector('[role="alertdialog"]'));
    if (!files.has(asset.source)) throw Error('Cancel deleted media');
    selectAndDelete();
    await until(() => !!document.querySelector('[role="alertdialog"]'));
    const confirm = [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find(button => button.textContent === 'Delete media');
    if (!confirm) throw Error('Missing delete confirmation');
    confirm.click();
    await until(() => !library.get(asset.id));
    if (files.has(asset.source)) throw Error('Confirmed deletion did not remove project-owned media');
  } finally { dispose(); host.remove(); world.destroy(); await library.dispose(); }
}
