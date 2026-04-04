function createAuthService({ authMode, allowedFingerprints, logInfo, unauthorizedMessage }) {
	function requestFingerprint(ctx) {
		const userId = ctx?.from?.id;
		if (userId === undefined || userId === null) {
			return null;
		}
		return String(userId);
	}

	async function authorizeRequest(ctx) {
		const chatId = ctx?.chat?.id || null;
		const userId = ctx?.from?.id || null;
		const fingerprint = requestFingerprint(ctx);

		if (!fingerprint) {
			logInfo('auth.denied.missing_fingerprint', { chatId, userId });
			await ctx.reply(unauthorizedMessage);
			return false;
		}

		if (authMode === 'discovery') {
			logInfo('auth.discovery.fingerprint', { chatId, userId, fingerprint });
			await ctx.reply(
				[`Fingerprint: ${fingerprint}`, 'Agrega este valor a TELEGRAM_ALLOWED_FINGERPRINTS y elimina * para activar allowlist.'].join('\n'),
			);
			return false;
		}

		if (authMode === 'deny-all') {
			logInfo('auth.denied.deny_all', { chatId, userId, fingerprint });
			await ctx.reply(unauthorizedMessage);
			return false;
		}

		if (!allowedFingerprints.has(fingerprint)) {
			logInfo('auth.denied.not_allowed', { chatId, userId, fingerprint });
			await ctx.reply(unauthorizedMessage);
			return false;
		}

		return true;
	}

	return {
		authorizeRequest,
		requestFingerprint,
	};
}

export { createAuthService };
