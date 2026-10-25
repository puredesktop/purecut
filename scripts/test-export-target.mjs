// Real muxer checks that need neither browser codecs nor a desktop file bridge.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { Output, WebMOutputFormat, EncodedVideoPacketSource, EncodedPacket } from 'mediabunny';

const out = await mkdtemp(fileURLToPath(new URL('../node_modules/.cache-export-target-', import.meta.url)));
try {
  await build({
    entryPoints: ['packages/encoder/src/buffer.ts'], outfile: `${out}/buffer.mjs`,
    bundle: true, platform: 'node', format: 'esm', external: ['mediabunny'], logLevel: 'error',
  });
  const { TargetBuffer } = await import(`${out}/buffer.mjs`);
  const create = async sink => {
    const buffer = await TargetBuffer.create({ createWritable: async () => new WritableStream(sink) }, 1024);
    const output = new Output({ format: new WebMOutputFormat(), target: buffer.target });
    const source = new EncodedVideoPacketSource('vp8');
    output.addVideoTrack(source);
    await output.start();
    return { buffer, output, source };
  };
  // Payload bytes are synthetic: this probes muxing/writes, never decoding.
  const add = (source, frame) => source.add(new EncodedPacket(new Uint8Array(2048), 'key', frame / 24, 1 / 24), {
    decoderConfig: { codec: 'vp8', codedWidth: 320, codedHeight: 180 },
  });
  const isWriteError = error => error.name === 'ExportError' && error.stage === 'write';

  let writes = 0, failedAborts = 0;
  const diskFull = Error('disk full');
  const failed = await create({ write() { if (++writes === 2) throw diskFull; }, abort() { failedAborts++; } });
  await assert.rejects(async () => {
    for (let frame = 0; frame < 24; frame++) await add(failed.source, frame);
  }, error => isWriteError(error) && error.cause === diskFull);
  assert.equal(writes, 2, 'a chunk succeeds before a write fails during packet addition, without finalize');
  failed.buffer.cancel();
  await failed.output.cancel();
  assert.equal(failedAborts, 1, 'a failed output aborts its writable instead of leaving it open');

  let closes = 0, aborts = 0;
  const canceled = await create({ write() {}, close() { closes++; }, abort() { aborts++; } });
  await add(canceled.source, 0);
  canceled.buffer.cancel();
  await canceled.output.cancel();
  assert.equal(aborts, 1, 'cancel aborts the file instead of saving the partial output');
  assert.equal(closes, 0);

  const closeError = Error('close failed');
  const closing = await create({ write() {}, close() { throw closeError; } });
  await add(closing.source, 0);
  await assert.rejects(closing.output.finalize(), error => isWriteError(error) && error.cause === closeError);

  const saved = await create({ write() {}, close() { closes++; }, abort() { aborts++; } });
  await add(saved.source, 0);
  await saved.output.finalize();
  assert.equal(closes, 1, 'success closes normally');
  assert.equal(aborts, 1, 'success does not abort');
  console.log('PASS: mid-export write classification, cancel abort, close failure, successful close');
} finally {
  await rm(out, { recursive: true, force: true });
}
