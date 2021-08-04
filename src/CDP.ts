import Decimal from 'decimal.js'
import { Coin, Coins, Denom, MsgExecuteContract } from '@terra-money/terra.js'
import { Mirror, AssetInfo, Token, Asset, NativeToken, TerraswapPair } from '@mirror-protocol/mirror.js'

const MICRO_MULTIPLIER = 1_000_000

export class CDP {
	premium: Decimal = new Decimal(1)
	#denom: string
	#mirrorClient: Mirror
	idx: string
	assetAdress: string
	assetName: string
	minCollateralRatio = 2
	assetPrice: Decimal = new Decimal(0)
	collateralPrice: Decimal = new Decimal(0)
	collateralInfo!: Asset<AssetInfo>
	collateralName: string
	collateralMultiplier = 1
	assetInfo!: Asset<Token>
	isShort: boolean
	mintable: boolean
	#time: Date
	#marketOpenParams: [number, number] // Time and block of last price update
	hasLockedUST: boolean

	constructor(
		mirrorClient: Mirror,
		idx: string,
		assetName: string,
		collateralName: string,
		isShort: boolean,
		denom: string
	) {
		this.#mirrorClient = mirrorClient
		this.idx = idx
		this.assetName = assetName
		this.collateralName = collateralName
		this.assetAdress = this.#mirrorClient.assets[this.assetName].token.contractAddress as string
		this.#denom = denom
		this.#time = new Date()
		this.mintable = true
		this.#marketOpenParams = [0, 0]
		this.isShort = isShort
		this.hasLockedUST = false
	}

	async setCDPTokenInfo(): Promise<void> {
		try {
			await this.setCollateralInfo()
			await this.setAssetAndCollateralAmount()
			await this.updateAssetAndCollateralPrice()
			await this.updateOpenMarketParam()
		} catch (err) {
			console.error('Updating CDP token info failed: ' + err)
		}
	}

	async updateAndGetRelativeOCR(): Promise<Decimal | undefined> {
		try {
			await this.updateAssetAndCollateralPrice()
			const collateralValue = this.getCollateralValue()
			const lentValue = this.getLentValue()
			return collateralValue.dividedBy(lentValue).minus(this.minCollateralRatio)
		} catch (err) {
			console.error(`Updating ${this.assetName} OCR failed: ` + err)
		}
	}

	async updateAssetAndCollateralPrice (): Promise<void> {
		this.collateralPrice = new Decimal(
			(await this.#mirrorClient.collateralOracle.getCollateralPrice(this.collateralName)).rate
		)
		const priceData = await this.#mirrorClient.oracle.getPrice(this.#denom, this.assetAdress)
		this.assetPrice = new Decimal(1 / parseFloat(priceData.rate))
		if (this.#marketOpenParams[1] != priceData.last_updated_quote) {
			this.#marketOpenParams[0] = this.#time.getTime()
			this.#marketOpenParams[1] = priceData.last_updated_quote
			this.mintable = true
		} else if (this.#marketOpenParams[0] <= this.#time.getTime() - 120000) {
			this.mintable = false
		}
	}

	async updateOpenMarketParam(): Promise<void> {
		this.#marketOpenParams[0] = this.#time.getTime()
		this.#marketOpenParams[1] = (
			await this.#mirrorClient.oracle.getPrice(this.#denom, this.assetAdress)
		).last_updated_quote
	}

	async getAssetAmountToCompensate(desiredOcrMargin: Decimal): Promise <Decimal> {
		await this.updateAssetAndCollateralPrice()
		await this.setPremium()
		const goalOCR = desiredOcrMargin.add(this.minCollateralRatio)
		const collateralValue = this.getCollateralValue()
		const lentValue = this.getLentValue()
		const currentOCR = (await this.updateAndGetRelativeOCR() as Decimal).plus(this.minCollateralRatio)
		return lentValue
			.minus(collateralValue.dividedBy(goalOCR.minus(currentOCR).plus(collateralValue.dividedBy(lentValue))))
			.dividedBy(this.assetPrice)
	}

	protected async setCollateralInfo(): Promise<void> {
		const collateralAssetInfo = await this.#mirrorClient.collateralOracle.getCollateralAssetInfo(this.collateralName)
		this.collateralMultiplier = parseFloat(collateralAssetInfo.multiplier)
	}

	async setAssetAndCollateralAmount(): Promise<void> {
		const cdp = await this.#mirrorClient.mint.getPosition(this.idx)
		this.collateralInfo = cdp.collateral
		this.assetInfo = cdp.asset
		this.minCollateralRatio =
			parseFloat(
				(await this.#mirrorClient.mint.getAssetConfig(this.assetInfo.info.token.contract_addr)).min_collateral_ratio
			) * this.collateralMultiplier
	}

	async getOnchainReverseSim(shortAmount: Decimal): Promise<Decimal> {
		const pair = new TerraswapPair({
			contractAddress: this.#mirrorClient.assets[this.assetName].pair.contractAddress,
			lcd: this.#mirrorClient.lcd,
		})
		const tokenAsset: Asset<Token> = {
			info: this.assetInfo.info,
			amount: shortAmount.times(MICRO_MULTIPLIER).toFixed(0),
		}
		const simResults = await pair.getReverseSimulation(tokenAsset)
		return new Decimal(simResults.offer_amount).plus(
			new Decimal(simResults.spread_amount).plus(new Decimal(simResults.commission_amount))
		)
	}

	async constructBurnMsg(mAssetToRepay: Decimal): Promise<MsgExecuteContract> {
		const asset = (await this.#mirrorClient.mint.getPosition(this.idx)).asset
		asset.amount = mAssetToRepay.times(MICRO_MULTIPLIER).toFixed(0)
		return this.#mirrorClient.mint.burn(this.idx, asset)
	}

	constructCollateralDepositMsg(neededUSTValue: Decimal): MsgExecuteContract {
		const collateralAmount = neededUSTValue.times(MICRO_MULTIPLIER).dividedBy(this.collateralPrice)
		const collateralAsset: Asset<AssetInfo> = { info: this.collateralInfo.info, amount: collateralAmount.toFixed(0) }
		return this.#mirrorClient.mint.deposit(new Decimal(this.idx), collateralAsset)
	}

	constructMintMsg(amount: Decimal): MsgExecuteContract {
		const assetToken = this.assetInfo
		assetToken.amount = amount.times(MICRO_MULTIPLIER).toFixed(0)
		return this.#mirrorClient.mint.mint(new Decimal(this.idx), assetToken)
	}

	contructUnstakeMsg(amount: Decimal): MsgExecuteContract {
		return this.#mirrorClient.staking.unbond(this.assetAdress, amount)
	}

	constructUnbondMsg(LP_token_amount: Decimal): MsgExecuteContract {
		const amount = LP_token_amount.toFixed(0)
		return new MsgExecuteContract(
			this.#mirrorClient.key.accAddress,
			this.#mirrorClient.assets[this.assetName].lpToken.contractAddress as string,
			{
				send: {
					amount: amount,
					contract: this.#mirrorClient.assets[this.assetName].pair.contractAddress,
					msg: 'eyJ3aXRoZHJhd19saXF1aWRpdHkiOnt9fQ==',
				},
			},
			new Coins()
		)
	}

	constructBuyAndLPMsg(amount: Decimal, swapUST: Decimal, LPUST: Decimal): MsgExecuteContract[] {
		const denomAsset: Asset<NativeToken> = {
			info: <NativeToken>{ native_token: { denom: Denom.USD } },
			amount: swapUST.times(MICRO_MULTIPLIER).toFixed(0),
		}

		const LPust: Asset<NativeToken> = {
			info: <NativeToken>{ native_token: { denom: Denom.USD } },
			amount: LPUST.times(MICRO_MULTIPLIER).toFixed(0),
		}
		const tokenAsset: Asset<Token> = { info: this.assetInfo.info, amount: amount.times(MICRO_MULTIPLIER).toFixed(0) }
		const address = this.#mirrorClient.key.accAddress
		const pairAddress = this.#mirrorClient.assets[this.assetName].pair.contractAddress
		const tokenAddress = tokenAsset.info.token.contract_addr
		const coins = new Coins([new Coin(denomAsset.info.native_token.denom, denomAsset.amount)])

		// console.log(
		// 	`LPing ${amount} with a value of ${amount.times(
		// 		this.assetPrice.times(this.premium)
		// 	)} together with ${LPUST} UST which gives a price of ${LPUST.dividedBy(
		// 		amount
		// 	)} and an on-chain price of ${this.assetPrice.times(this.premium)} which has a premium of ${this.premium}.`
		// )
		return [
			new MsgExecuteContract(address, tokenAddress, {
				// Increase contract allowance
				increase_allowance: {
					spender: pairAddress,
					amount: tokenAsset.amount,
					expires: { never: {} },
				},
			}),
			new MsgExecuteContract(
				address,
				pairAddress as string,
				{
					//Buy equal amount of mAsset tokens
					swap: {
						offer_asset: denomAsset,
						to: address,
					},
				},
				coins
			),
			new MsgExecuteContract(address, tokenAddress, {
				// Increase contract allowance
				increase_allowance: {
					spender: this.#mirrorClient.staking.contractAddress,
					amount: tokenAsset.amount,
					expires: { never: {} },
				},
			}),
			this.#mirrorClient.staking.autoStake(LPust, tokenAsset),
		]
	}

	async setPremium(): Promise<void> {
		const pair = new TerraswapPair({
			contractAddress: this.#mirrorClient.assets[this.assetName].pair.contractAddress,
			lcd: this.#mirrorClient.lcd,
		})
		const poolInfo = await pair.getPool()
		const onChainPrice = new Decimal(poolInfo.assets[0].amount).dividedBy(new Decimal(poolInfo.assets[1].amount))
		this.premium = onChainPrice.minus(this.assetPrice).dividedBy(this.assetPrice).plus(new Decimal(1))
	}

	constructWithdrawMsg(collateralWithdrawValue: Decimal): MsgExecuteContract {
		const cInfo = this.collateralInfo
		cInfo.amount = collateralWithdrawValue.dividedBy(this.collateralPrice).times(MICRO_MULTIPLIER).toFixed(0)

		return this.#mirrorClient.mint.withdraw(new Decimal(this.idx), cInfo)
	}

	getLentValue(): Decimal {
		return new Decimal(this.assetInfo.amount).times(this.assetPrice).dividedBy(MICRO_MULTIPLIER)
	}

	getCollateralValue(): Decimal {
		return new Decimal(this.collateralInfo.amount).times(this.collateralPrice).dividedBy(MICRO_MULTIPLIER)
	}

	async tryClaimLockedFunds(): Promise<void> {
		const lockBlock = (await this.#mirrorClient.lock.getPositionLockInfo(new Decimal(this.idx))).locked_funds
		for (const i in lockBlock){
			console.log(`UST locked on ${lockBlock[i]}`)
		}
		
		
		// const lockupPeriod = (await this.#mirrorClient.lock.getConfig()).lockup_period
		// console.log(`Latest block is ${(await this.#mirrorClient.lcd.tendermint.blockInfo()).block.header.height}`)
		// // for (let funds of lockBlock) {
		// 	console.log(
		// 		`Locking period is ${lockupPeriod} with funds locked on block ${funds[0]} and current block ${parseInt(
		// 			(await this.#mirrorClient.lcd.tendermint.blockInfo()).block.header.height
		// 		)}`
		// 	)
		// 	if (
		// 		funds[0] + lockupPeriod <
		// 		parseInt((await this.#mirrorClient.lcd.tendermint.blockInfo()).block.header.height)
		// 	) {
		// 		console.log('CLAIMING')
		// 	}
		// }
	}
}
