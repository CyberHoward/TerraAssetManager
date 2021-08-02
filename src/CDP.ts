import { dset } from 'dset'
import dedent from 'dedent-js'
import Decimal from 'decimal.js'
import {
	Coin,
	Coins,
	Denom,
	LCDClient,
	MnemonicKey,
	Msg,
	MsgExecuteContract,
	MsgSwap,
	StdFee,
	Wallet,
} from '@terra-money/terra.js'
import {
	AddressProviderFromJson,
	Anchor,
	COLLATERAL_DENOMS,
	columbus4,
	MARKET_DENOMS,
	tequila0004,
} from '@anchor-protocol/anchor.js'
import {
	DEFAULT_TEQUILA_MIRROR_OPTIONS,
	DEFAULT_MIRROR_OPTIONS,
	Mirror,
	AssetInfo,
	Token,
	Asset,
	MirrorMint,
	NativeToken,
	AssetOptions,
	TerraswapPair,
} from '@mirror-protocol/mirror.js'
import { Logger } from './Logger'

const MICRO_MULTIPLIER = 1_000_000

export class CDP {
	premium: Decimal
	#denom: string
	#mirrorClient: Mirror
	idx: string
	assetAdress: string
	assetName: string
	minCollateralRatio = 2
	assetPrice: Decimal
	collateralPrice: Decimal
	collateralInfo: Asset<AssetInfo>
	collateralName: string
	collateralMultiplier: number
	assetInfo: Asset<Token>
	isShort: boolean
	mintable: boolean
	#time: Date
	#marketOpenParams: [number, number] // Time and block of last price update

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
		this.mintable = true // Nog aanpassen!
		this.#marketOpenParams = [0, 0]
		this.isShort = isShort
	}

	async updateCDPTokenInfo(): Promise<void> {
		try {
			await this.setCollateralAssetInfo()
			await this.setAssetAndCollateralInfo()
		} catch (err) {
			console.error('Updating CDP token info failed: ' + err)
		}
	}

	async updateAndGetRelativeOCR(): Promise<Decimal | undefined> {
		try {
			this.collateralPrice = new Decimal(
				(await this.#mirrorClient.collaterallOracle.getCollateralPrice(this.collateralName)).rate
			)
			const priceData = await this.#mirrorClient.oracle.getPrice(this.#denom, this.assetAdress)
			console.log(`This asset is mintable ${this.mintable}`)
			// console.log(`Current quote block is ${priceData.last_updated_quote} while last update was ${this.#marketOpenParams[1]}`)
			if (this.#marketOpenParams[1] != priceData.last_updated_quote) {
				this.#marketOpenParams[0] = this.#time.getTime()
				this.#marketOpenParams[1] = priceData.last_updated_quote
				this.mintable = true
				console.log("Setting asset to mintable")
			} else if (this.#marketOpenParams[0] <= this.#time.getTime() - 120000) {
				this.mintable = false
				console.log("Setting asset to unmintable")
			}
			this.assetPrice = new Decimal(1 / parseFloat(priceData.rate))

			//console.log(`The price of ${this.assetName} is ${this.assetPrice}`)
			const collateralValue = new Decimal(this.collateralInfo.amount)
				.times(this.collateralPrice)
				.dividedBy(MICRO_MULTIPLIER)
			const lentValue = new Decimal(this.assetInfo.amount).times(this.assetPrice).dividedBy(MICRO_MULTIPLIER)
			//Logger.log(`The ${this.assetName} lent value is: ${lentValue} with a collateral value of: ${collateralValue} resulting in a OCR ratio of ${collateralValue.dividedBy(lentValue.times(this.#collateralMultiplier))}.`)
			return collateralValue.dividedBy(lentValue.times(this.collateralMultiplier)).minus(this.minCollateralRatio)
		} catch (err) {
			console.error(`Updating ${this.assetName} OCR failed: ` + err)
		}
	}

	async updateOpenMarketParam(): Promise<void> {
		this.#marketOpenParams[0] = this.#time.getTime()
		this.#marketOpenParams[1] = (
			await this.#mirrorClient.oracle.getPrice(this.#denom, this.assetAdress)
		).last_updated_quote
		// console.log(`Last quote block is ${this.#marketOpenParams[0]}`)
	}

	getAssetAmountToCompensate(desiredOcrMargin: Decimal): Decimal {
		const goalOCR = desiredOcrMargin.add(this.minCollateralRatio)
		const collateralValue = new Decimal(this.collateralInfo.amount)
			.times(this.collateralPrice)
			.dividedBy(this.collateralMultiplier)
			.dividedBy(MICRO_MULTIPLIER)
		const lentValue = new Decimal(this.assetInfo.amount).times(this.assetPrice).dividedBy(MICRO_MULTIPLIER)
		const currentOCR = collateralValue.dividedBy(lentValue)
		// Logger.log(`Need to transact ${lentValue.minus(collateralValue.dividedBy((goalOCR.minus(currentOCR)).plus(collateralValue.dividedBy(lentValue)))).dividedBy(this.assetPrice)} ${this.assetName}`)
		return lentValue
			.minus(collateralValue.dividedBy(goalOCR.minus(currentOCR).plus(collateralValue.dividedBy(lentValue))))
			.dividedBy(this.assetPrice)
	}

	protected async setCollateralAssetInfo(): Promise<void> {
		const collateralAssetInfo = await this.#mirrorClient.collaterallOracle.getCollateralAssetInfo(this.collateralName)
		this.collateralPrice = new Decimal(
			(await this.#mirrorClient.collaterallOracle.getCollateralPrice(this.collateralName)).rate
		)
		this.collateralMultiplier = parseFloat(collateralAssetInfo.multiplier)
		// Logger.log("The collateral price is updated to: " + this.collateralPrice.toString() +"\n By using this collateral the minimum OCR is multiplied with a factor of : " + this.#collateralMultiplier)
	}

	protected async setAssetAndCollateralInfo(): Promise<void> {
		const cdp = await this.#mirrorClient.mint.getPosition(this.idx)
		this.collateralInfo = cdp.collateral
		this.assetInfo = cdp.asset
		this.minCollateralRatio = parseFloat(
			(await this.#mirrorClient.mint.getAssetConfig(this.assetInfo.info.token.contract_addr)).min_collateral_ratio
		)
		// Logger.log(`The minimum collateral ration of asset ${this.assetName} at address ${(<Token> this.assetInfo.info ).token.contract_addr}  / ${this.assetAdress} is ${this.#minCollateralRatio}`)
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
		return new Decimal(simResults.offer_amount)
	}

	// async updateOnchainAssetPrice() {}

	async constructBurnMsg(mAssetToRepay: Decimal): Promise<MsgExecuteContract> {
		const asset = (await this.#mirrorClient.mint.getPosition(this.idx)).asset
		asset.amount = mAssetToRepay.times(MICRO_MULTIPLIER).toFixed(0)
		return this.#mirrorClient.mint.burn(this.idx, asset)
	}

	constructCollateralDepositMsg(neededUSTValue: Decimal): MsgExecuteContract {
		const collateralAmount = neededUSTValue
			.times(MICRO_MULTIPLIER)
			.times(this.minCollateralRatio)
			.dividedBy(this.collateralPrice)
		console.log(`I need to repay ${neededUSTValue} UST by depositing ${collateralAmount} aUST`)
		const collateralAsset: Asset<AssetInfo> = { info: this.collateralInfo.info, amount: collateralAmount.toString() }
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
		//  console.log('Withdrawing '+tokenName+' LP...')
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

	constructBuyAndLPMsg(amount: Decimal, neededUST: Decimal): MsgExecuteContract[] {
		const denomAsset: Asset<NativeToken> = {
			info: <NativeToken>{ native_token: { denom: Denom.USD } },
			amount: neededUST.times(MICRO_MULTIPLIER).toFixed(0),
		}
		const tokenAsset: Asset<Token> = { info: this.assetInfo.info, amount: amount.times(MICRO_MULTIPLIER).toFixed(0) }
		const address = this.#mirrorClient.key.accAddress
		const pairAddress = this.#mirrorClient.assets[this.assetName].pair.contractAddress
		const tokenAddress = tokenAsset.info.token.contract_addr
		const coins = new Coins([new Coin(denomAsset.info.native_token.denom, denomAsset.amount)])

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
			this.#mirrorClient.staking.autoStake(denomAsset, tokenAsset),
		]
	}

	async setPremium(): Promise<void> {
		this.premium = (new Decimal((await this.#mirrorClient.staking.getPoolInfo(this.#mirrorClient.assets[this.assetName].token.contractAddress as string)).premium_rate)).plus(1)
	}
	constructUndoFarmMsg(): MsgExecuteContract[] {
		//Unstake, un
	}

	// async tryClaimLockedFunds(){
	//     const lockBlock = (await this.#mirrorClient.lock.getPositionLockInfo(new Decimal(this.idx))).locked_funds[0]
	//     const lockupPeriod = (await this.#mirrorClient.lock.getConfig()).lockup_period
	//     console.log(lockBlock)
	//     for (let funds of lockBlock) {
	//         console.log(`Locking period is ${lockupPeriod} with funds locked on block ${funds[0]} and current block ${parseInt((await this.#mirrorClient.lcd.tendermint.blockInfo()).block.header.height)}`)
	//         if (funds[0] + lockupPeriod < parseInt((await this.#mirrorClient.lcd.tendermint.blockInfo()).block.header.height)){
	//             console.log("CLAIMING")
	//         }
	//     }
	// }
}
