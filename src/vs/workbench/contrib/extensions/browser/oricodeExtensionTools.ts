/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { localize } from '../../../../nls.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ProgressLocation } from '../../../../platform/progress/common/progress.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { EnablementState } from '../../../services/extensionManagement/common/extensionManagement.js';
import { IExtension, IExtensionsWorkbenchService } from '../common/extensions.js';

/**
 * OriCode agent extension tools — gallery search, install check, and a
 * user-confirmed install. Every install goes through the native workbench
 * gallery flow (publisher/policy prompts intact); nothing is installed,
 * enabled or disabled without an explicit confirmed dialog per request.
 */

const EXTENSION_ID_RE = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/i;

function extensionIdOf(raw: unknown): string {
	const id = String(raw ?? '').trim().toLowerCase();
	if (!EXTENSION_ID_RE.test(id)) {
		throw new Error('extensionId inválido');
	}
	return id;
}

function isEnabled(extension: IExtension): boolean {
	return extension.enablementState === EnablementState.EnabledGlobally
		|| extension.enablementState === EnablementState.EnabledWorkspace;
}

function localSummary(extension: IExtension) {
	return {
		installed: true,
		enabled: isEnabled(extension),
		version: extension.version,
		displayName: extension.displayName,
		publisher: extension.publisherDisplayName ?? extension.publisher,
		runtimeState: extension.runtimeState?.reason,
	};
}

async function findLocal(service: IExtensionsWorkbenchService, id: string): Promise<IExtension | undefined> {
	const installed = await service.queryLocal();
	return installed.find(extension => extension.identifier.id.toLowerCase() === id);
}

const pendingRequests = new Map<string, { cancelled: boolean }>();

CommandsRegistry.registerCommand('oricode.extensions.search', async (accessor: ServicesAccessor, args?: { query?: string }) => {
	const query = String(args?.query ?? '').trim();
	if (!query) {
		throw new Error('query requerido');
	}
	const service = accessor.get(IExtensionsWorkbenchService);
	const pager = await service.queryGallery({ text: query, pageSize: 5 }, CancellationToken.None);
	return pager.firstPage.map(extension => ({
		id: extension.identifier.id,
		displayName: extension.displayName,
		publisher: extension.publisherDisplayName ?? extension.publisher,
		version: extension.version,
		description: extension.description,
	}));
});

CommandsRegistry.registerCommand('oricode.extensions.check', async (accessor: ServicesAccessor, args?: { extensionId?: string }) => {
	const id = extensionIdOf(args?.extensionId);
	const service = accessor.get(IExtensionsWorkbenchService);
	const local = await findLocal(service, id);
	if (!local) {
		return { installed: false };
	}
	return localSummary(local);
});

CommandsRegistry.registerCommand('oricode.extensions.install', async (accessor: ServicesAccessor, args?: { extensionId?: string; reason?: string; requestId?: string }) => {
	const service = accessor.get(IExtensionsWorkbenchService);
	const trust = accessor.get(IWorkspaceTrustManagementService);
	const dialogs = accessor.get(IDialogService);

	const id = extensionIdOf(args?.extensionId);
	const reason = String(args?.reason ?? '').trim();
	if (!reason || reason.length > 1000) {
		throw new Error('reason requerido (máximo 1000 caracteres)');
	}
	const requestId = String(args?.requestId ?? '');
	if (!requestId) {
		throw new Error('requestId requerido');
	}
	if (!trust.isWorkspaceTrusted()) {
		throw new Error('Instalar extensiones requiere un espacio de trabajo de confianza.');
	}

	const request = { cancelled: false };
	pendingRequests.set(requestId, request);
	try {
		const existing = await findLocal(service, id);
		if (existing) {
			// Already installed — report state only; never enable/disable silently.
			return { ...localSummary(existing), alreadyInstalled: true };
		}

		const gallery = await service.getExtensions([{ id }], CancellationToken.None);
		const extension = gallery.find(candidate => candidate.identifier.id.toLowerCase() === id);
		if (!extension) {
			return { installed: false, unavailable: true, message: `'${id}' no está disponible en el catálogo` };
		}

		const extras = [...(extension.dependencies ?? []), ...(extension.extensionPack ?? [])];
		const detail = reason + '\n' + id + (extras.length ? '\n' + localize('oricode.ext.alsoInstalls', "También se instalará: {0}", extras.join(', ')) : '');
		const confirmation = await dialogs.confirm({
			type: 'question',
			message: localize('oricode.ext.confirmInstall', "Install {0} by {1}?", extension.displayName, extension.publisherDisplayName ?? extension.publisher),
			detail,
			primaryButton: localize('oricode.ext.install', "Install"),
		});
		if (request.cancelled || !confirmation.confirmed) {
			return { declined: true };
		}
		if (!trust.isWorkspaceTrusted()) {
			throw new Error('El espacio de trabajo dejó de ser de confianza.');
		}
		await service.install(extension, { installPreReleaseVersion: false, isMachineScoped: true }, ProgressLocation.Notification);

		const after = await findLocal(service, id);
		if (!after) {
			throw new Error('La instalación terminó pero la extensión no aparece instalada.');
		}
		return localSummary(after);
	} finally {
		pendingRequests.delete(requestId);
	}
});

CommandsRegistry.registerCommand('oricode.extensions.cancel', (_accessor: ServicesAccessor, requestId?: string) => {
	const pending = pendingRequests.get(String(requestId ?? ''));
	if (pending) {
		pending.cancelled = true;
	}
});
