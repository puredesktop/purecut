import { AssetLibrary, type ProjectFS } from '@diffusionstudio/assets';
import { createRuntimeWorld, Library } from '@diffusionstudio/runtime';
import { WorldProvider } from '@diffusionstudio/koota-solid';
import { render } from 'solid-js/web';
import { PromptInputProvider } from '../apps/web/src/context/prompt-input';
import { Assets } from '../apps/web/src/components/sidebar-left/assets';
import { AssetInfoPreview } from '../apps/web/src/components/sidebar-right/inspector/asset-info-preview';
import { AssetInfoPanel } from '../apps/web/src/components/sidebar-right/inspector/asset-info';
import { undoEdit, redoEdit } from '../apps/web/src/engine/input/shortcuts';
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
    world.set(AssetSelection, { id: asset.id });
    dispose = render(() => <WorldProvider world={world}><AssetInfoPanel /></WorldProvider>, host);
    const pick = HTMLInputElement.prototype.click;
    try {
      canvas.getContext('2d')!.fillRect(0, 0, 16, 16);
      const replacement = await new Promise<Blob>(resolve => canvas.toBlob(value => resolve(value!), 'image/png'));
      HTMLInputElement.prototype.click = function () {
        const transfer = new DataTransfer(); transfer.items.add(new File([replacement], 'replacement.png', { type: 'image/png' }));
        this.files = transfer.files; this.dispatchEvent(new Event('change'));
      };
      const replaceButton = [...host.querySelectorAll('button')].find(button => button.textContent === 'Replace source');
      if (!replaceButton) throw Error('Inspector must offer Replace source');
      replaceButton.click();
      await until(() => library.get('safe.png')?.id !== asset.id);
      const replacementId = library.get('safe.png')!.id;
      await until(() => world.get(AssetSelection)?.id === replacementId && !!host.querySelector('img')?.src);
      undoEdit(world);
      await until(() => world.get(AssetSelection)?.id === asset.id && !!host.querySelector('img')?.src);
      if (host.textContent?.includes('Untitled') || !host.textContent?.includes(asset.source))
        throw Error('Inspector must still show the selected original asset after Undo');
      redoEdit(world);
      await until(() => world.get(AssetSelection)?.id === replacementId && !!host.querySelector('img')?.src);
      undoEdit(world);
      await until(() => world.get(AssetSelection)?.id === asset.id);
    } finally { HTMLInputElement.prototype.click = pick; }
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
