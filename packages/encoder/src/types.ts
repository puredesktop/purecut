/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { StreamTargetChunk } from 'mediabunny';

/** Container format of the output file. */
export type ContainerFormat = 'mp4' | 'webm' | 'ogg' | 'mov';

// Minimal FileSystemFileHandle-shaped target
export interface WritableFileTarget {
	createWritable(): Promise<WritableStream<StreamTargetChunk>>;
	/** Aborts and removes the partial output even after its stream has failed. */
	dispose?(): Promise<void>;
}

export type EncoderProgress = {
	total: number;
	progress: number;
	remaining: Date;
};

export type ExportStage = 'render' | 'decode' | 'encode' | 'write';

export class ExportError extends Error {
	public readonly cause: unknown;

	public constructor(public readonly stage: ExportStage, error: unknown) {
		super(error instanceof Error ? error.message : String(error));
		this.name = 'ExportError';
		this.cause = error;
	}
}

export function asExportError(stage: ExportStage, error: unknown): ExportError {
	return error instanceof ExportError ? error : new ExportError(stage, error);
}

export type ExportResult =
	| {
		type: 'success';
		data: Blob | undefined;
	}
	| {
		type: 'canceled';
	}
	| {
		type: 'error';
		error: ExportError;
	};
