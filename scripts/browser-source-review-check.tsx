import { render } from 'solid-js/web';
import { createSourceReview, SourceEditReview } from '../purecut/edit-review';

export async function checkSourceReview() {
  const review = createSourceReview();
  const host = document.createElement('div');
  document.body.append(host);
  const dispose = render(() => <SourceEditReview review={review} />, host);
  const proposal = { dir: '/example.cut', before: 'Before text', source: 'After text', baseHash: 'old', hash: 'new' };
  const check = (value: unknown, message: string) => { if (!value) throw Error(message); };
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  let applied = 0;
  try {
    review.present(proposal, async () => { applied++; });
    await tick();
    check(applied === 0, 'presenting a proposal must not apply it');
    const panel = () => document.querySelector('.cut-source-review')!;
    check(panel().textContent?.includes('Before text') && panel().textContent?.includes('After text'), 'review shows both source snapshots');
    check(document.activeElement?.textContent === 'Discard', 'review initially focuses discard');
    let rejected = false;
    try { review.present(proposal, async () => {}); } catch { rejected = true; }
    check(rejected, 'a second proposal cannot overwrite an unreviewed edit');
    const buttons = () => [...panel().querySelectorAll('button')];
    buttons().find(button => button.textContent === 'Discard')!.click();
    check(!review.proposal() && applied === 0, 'discard does not write');
    review.present(proposal, async () => { throw Error('Project changed'); });
    await review.apply();
    check(review.error() === 'Project changed' && !!review.proposal() && !review.busy(), 'failed application retains review and exposes error');
    review.dismiss();
    let finish!: () => void;
    review.present(proposal, async value => {
      check(value.source === 'After text' && value.baseHash === 'old', 'apply uses reviewed snapshot');
      applied++;
      await new Promise<void>(resolve => { finish = resolve; });
    });
    const pending = review.apply();
    await review.apply();
    review.dismiss();
    check(applied === 1 && review.busy() && !!review.proposal(), 'pending apply prevents duplication and dismissal');
    finish();
    await pending;
    check(!review.proposal() && !review.busy(), 'successful apply closes review');
    review.present(proposal, async () => { applied++; });
    await tick();
    panel().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    check(!review.proposal() && applied === 1, 'Escape discards without applying');
    review.present(proposal, async () => { applied++; });
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    check(!review.proposal() && applied === 1, 'navigation dismisses pending review without applying');
  } finally { dispose(); host.remove(); }
}
