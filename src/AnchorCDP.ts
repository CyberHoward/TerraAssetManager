import { dset } from 'dset'
import dedent from 'dedent-js'
import Decimal from 'decimal.js'
import { Coin, Coins, Denom, LCDClient, LocalTerra, MnemonicKey, Msg, MsgExecuteContract, MsgSwap, StdFee, Wallet } from '@terra-money/terra.js'
import {
	AddressProviderFromJson,
	Anchor,
	COLLATERAL_DENOMS,
	columbus4,
	fabricateTerraswapProvideLiquidityANC,
	fabricateTerraswapProvideLiquiditybLuna,
	MARKET_DENOMS,
	tequila0004,
} from '@anchor-protocol/anchor.js'
import {DEFAULT_TEQUILA_MIRROR_OPTIONS, DEFAULT_MIRROR_OPTIONS, Mirror, AssetInfo, Token, Asset, MirrorMint, AssetOptions, isNativeToken, TerraswapToken, NativeToken, TerraswapPair, } from '@mirror-protocol/mirror.js'
import { Logger } from './Logger'
import { CDP } from './CDP'
//import terra from "@terra-money/terra.js"
const MICRO_MULTIPLIER = 1_000_000

export class AnchorCDP {

	#denom: any
	#config: any
	#anchor: Anchor
	#wallet: Wallet
	
	constructor(anchor: Anchor, denom: any, config: any, wallet: Wallet) {
		this.#wallet = wallet
		this.#anchor = anchor
		this.#denom = denom
		this.#config = config 
	}
	async computeLTV() {
		const borrowedValue = await this.getBorrowedValue()
		const borrowLimit = await this.getBorrowLimit()

		return borrowedValue.dividedBy(borrowLimit.times(2)).times(100)
	}

	async computeAmountToRepay(target = this.#config.ltv.safe) {
		const borrowedValue = await this.getBorrowedValue()
		const borrowLimit = await this.getBorrowLimit()
		const amountForSafeZone = new Decimal(target).times(borrowLimit.times(2).dividedBy(100))

		return borrowedValue.minus(amountForSafeZone)
	}

	async computeAmountToBorrow(target = this.#config.ltv.safe) {
		const borrowedValue = await this.getBorrowedValue()
		const borrowLimit = await this.getBorrowLimit()

		return new Decimal(target).times(borrowLimit.times(2)).dividedBy(100).minus(borrowedValue)
	}

	async getDeposit(){
		return new Decimal(await this.#anchor.earn.getTotalDeposit(this.#denom))
	}

	async getBorrowedValue(){
		return new Decimal(await this.#anchor.borrow.getBorrowedValue(this.#denom))
	}

	async getBorrowLimit(){
		return new Decimal(await this.#anchor.borrow.getBorrowLimit(this.#denom))
	}

	async getANCBalance(){
		return new Decimal(await this.#anchor.anchorToken.getBalance(this.#wallet.key.accAddress))
	}

	async getANCPrice(){
		return new Decimal(await this.#anchor.anchorToken.getANCPrice())
	}

	computeBorrowMessage(amount: Decimal) {
		return this.#anchor.borrow
			.borrow({ amount: amount.toFixed(3), market: MARKET_DENOMS.UUSD })
			.generateWithWallet(this.#wallet)
	}

	computeDepositMessage(amount: Decimal) {
		return this.#anchor.earn
			.depositStable({ amount: amount.toFixed(3), market: MARKET_DENOMS.UUSD })
			.generateWithWallet(this.#wallet)
	}

	computeWithdrawMessage(amount: Decimal) {
		return this.#anchor.earn
			.withdrawStable({ amount: amount.toFixed(3), market: MARKET_DENOMS.UUSD })
			.generateWithWallet(this.#wallet)
	}

	computeRepayMessage(amount: Decimal) {
		return this.#anchor.borrow
			.repay({ amount: amount.toFixed(3), market: MARKET_DENOMS.UUSD })
			.generateWithWallet(this.#wallet)
	}

	computeSellANCMessage(amount: Decimal) {
		return this.#anchor.anchorToken.sellANC(amount.toFixed(3)).generateWithWallet(this.#wallet)
	}

	computeStakeANCMessage(amount: Decimal) {
		return this.#anchor.anchorToken.stakeVotingTokens({ amount: amount.toFixed(3) }).generateWithWallet(this.#wallet)
	}

	executeClaimRewards() {
		return this.#anchor.anchorToken.claimUSTBorrowRewards({ market: MARKET_DENOMS.UUSD }).execute(this.#wallet, {})
	}
	
}