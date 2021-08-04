/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
/* eslint-disable @typescript-eslint/no-explicit-any */

import Decimal from 'decimal.js'
import { BlockTxBroadcastResult, Msg, Wallet } from '@terra-money/terra.js'
import { Anchor, MARKET_DENOMS } from '@anchor-protocol/anchor.js'

export class AnchorCDP {
	#denom: { address: string; market: MARKET_DENOMS }
	#config: any
	#anchor: Anchor
	#wallet: Wallet
	LTV: Decimal
	lentValue: Decimal

	constructor(anchor: Anchor, denom: { address: string; market: MARKET_DENOMS }, config: any, wallet: Wallet) {
		this.#wallet = wallet
		this.#anchor = anchor
		this.#denom = denom
		this.#config = config
		this.lentValue = new Decimal(0)
		this.LTV = new Decimal(0)
	}

	async setLTV(): Promise<void> {
		const borrowedValue = await this.getBorrowedValue()
		this.lentValue = borrowedValue
		const borrowLimit = await this.getBorrowLimit()
		this.LTV = borrowedValue.dividedBy(borrowLimit.dividedBy(0.6)).times(100)
	}

	async computeAmountToRepay(target = this.#config.ltv.safe): Promise<Decimal> {
		const borrowedValue = await this.getBorrowedValue()
		const borrowLimit = await this.getBorrowLimit()
		const amountForSafeZone = new Decimal(target).times(borrowLimit.dividedBy(0.6).dividedBy(100))

		return borrowedValue.minus(amountForSafeZone)
	}

	async computeAmountToBorrow(target = this.#config.ltv.safe): Promise<Decimal> {
		const borrowedValue = await this.getBorrowedValue()
		const borrowLimit = await this.getBorrowLimit()

		return new Decimal(target).times(borrowLimit.dividedBy(0.6)).dividedBy(100).minus(borrowedValue)
	}

	async getDeposit(): Promise<Decimal> {
		return new Decimal(await this.#anchor.earn.getTotalDeposit(this.#denom))
	}

	async getBorrowedValue(): Promise<Decimal> {
		return new Decimal(await this.#anchor.borrow.getBorrowedValue(this.#denom))
	}

	async getBorrowLimit(): Promise<Decimal> {
		return new Decimal(await this.#anchor.borrow.getBorrowLimit(this.#denom))
	}

	async getANCBalance(): Promise<Decimal> {
		return new Decimal(await this.#anchor.anchorToken.getBalance(this.#wallet.key.accAddress))
	}

	async getANCPrice(): Promise<Decimal> {
		return new Decimal(await this.#anchor.anchorToken.getANCPrice())
	}

	computeBorrowMessage(amount: Decimal): Msg[] {
		return this.#anchor.borrow
			.borrow({ amount: amount.toFixed(3), market: MARKET_DENOMS.UUSD })
			.generateWithWallet(this.#wallet)
	}

	computeDepositMessage(amount: Decimal): Msg[] {
		return this.#anchor.earn
			.depositStable({ amount: amount.toFixed(3), market: MARKET_DENOMS.UUSD })
			.generateWithWallet(this.#wallet)
	}

	computeWithdrawMessage(amount: Decimal): Msg[] {
		return this.#anchor.earn
			.withdrawStable({ amount: amount.toFixed(3), market: MARKET_DENOMS.UUSD })
			.generateWithWallet(this.#wallet)
	}

	computeRepayMessage(amount: Decimal): Msg[] {
		return this.#anchor.borrow
			.repay({ amount: amount.toFixed(3), market: MARKET_DENOMS.UUSD })
			.generateWithWallet(this.#wallet)
	}

	computeSellANCMessage(amount: Decimal): Msg[] {
		return this.#anchor.anchorToken.sellANC(amount.toFixed(3)).generateWithWallet(this.#wallet)
	}

	computeStakeANCMessage(amount: Decimal): Msg[] {
		return this.#anchor.anchorToken.stakeVotingTokens({ amount: amount.toFixed(3) }).generateWithWallet(this.#wallet)
	}

	executeClaimRewards(): Promise<BlockTxBroadcastResult> {
		return this.#anchor.anchorToken.claimUSTBorrowRewards({ market: MARKET_DENOMS.UUSD }).execute(this.#wallet, {})
	}
}
