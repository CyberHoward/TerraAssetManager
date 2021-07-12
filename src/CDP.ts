import { dset } from 'dset'
import dedent from 'dedent-js'
import Decimal from 'decimal.js'
import { Coin, Coins, Denom, LCDClient, MnemonicKey, Msg, MsgExecuteContract, MsgSwap, StdFee, Wallet } from '@terra-money/terra.js'
import {
	AddressProviderFromJson,
	Anchor,
	COLLATERAL_DENOMS,
	columbus4,
	MARKET_DENOMS,
	tequila0004,
} from '@anchor-protocol/anchor.js'
import {DEFAULT_TEQUILA_MIRROR_OPTIONS, DEFAULT_MIRROR_OPTIONS, Mirror, AssetInfo, Token, Asset, MirrorMint, AssetOptions} from '@mirror-protocol/mirror.js'
import { Logger } from './Logger'

const MICRO_MULTIPLIER = 1_000_000

export class CDP{

    #denom: string
    #mirrorClient: Mirror
    idx: string
    assetAdress: string
    assetName: string
    #minCollateralRatio: number
    assetPrice: Decimal
    collateralPrice: Decimal
    #collateralInfo: Asset<AssetInfo>
    collateralName: string
    #collateralMultiplier: number
    #assetInfo: Asset<AssetInfo>
    #isShort: Boolean
    mintable: Boolean 
    #time: Date
    #timeLastUpdate: number


    constructor(mirrorClient: Mirror ,idx: string, assetName: string, collateralName: string, isShort: Boolean, denom: string) {
		this.#mirrorClient = mirrorClient
        this.idx = idx
        this.assetName = assetName
        this.collateralName = collateralName
        this.assetAdress = this.#mirrorClient.assets[this.assetName].token.contractAddress
        this.#denom = denom
        this.#time = new Date()
        this.#timeLastUpdate = this.#time.getT
        console.log(this.#timeLastUpdate)
	}

    async updateCDPTokenInfo(){
        try{
            await this.setCollateralAssetInfo()
            await this.setAssetAndCollateralInfo()
        }catch(err){
            console.error("Updating CDP token info failed: " + err);
        };
    }

    async updateAndGetRelativeOCR(){
        try{
            
            this.collateralPrice = new Decimal((await this.#mirrorClient.collaterallOracle.getCollateralPrice(this.collateralName)).rate)
            const priceData = await this.#mirrorClient.oracle.getPrice(this.#denom,this.assetAdress)
            
            if (this.assetPrice != new Decimal(1/parseFloat(priceData.rate))){
                this.#timeLastUpdate = this.#time.getTime()
                this.mintable = true
            } else if (this.#time.getTime() - this.#timeLastUpdate   > 300){
                this.mintable = false
            } 

            this.assetPrice = new Decimal(1/parseFloat(priceData.rate))
            
            console.log(`The price of ${this.assetName} is ${this.assetPrice}`)
            const collateralValue = (new Decimal(this.#collateralInfo.amount).times(this.collateralPrice)).dividedBy(MICRO_MULTIPLIER) 
            const lentValue = (new Decimal(this.#assetInfo.amount).times(this.assetPrice)).dividedBy(MICRO_MULTIPLIER) 
            Logger.log(`The ${this.assetName} lent value is: ${lentValue} with a collateral value of: ${collateralValue} resulting in a OCR ratio of ${collateralValue.dividedBy(lentValue.times(this.#collateralMultiplier))}.`)
            return (collateralValue.dividedBy(lentValue.times(this.#collateralMultiplier))).minus(this.#minCollateralRatio);
        }catch(err){
            console.error(`Updating ${this.assetName} OCR failed: ` + err);
        }; 
    }

    getAssetAmountToRepay(desiredOcrMargin: Decimal){
        const goalOCR = desiredOcrMargin.add(this.#minCollateralRatio)
        const collateralValue = ((new Decimal(this.#collateralInfo.amount).times(this.collateralPrice)).dividedBy(this.#collateralMultiplier)).dividedBy(MICRO_MULTIPLIER)
        const lentValue = (new Decimal(this.#assetInfo.amount).times(this.assetPrice)).dividedBy(MICRO_MULTIPLIER)
        const currentOCR = collateralValue.dividedBy(lentValue)
        Logger.log(`Need to repay ${lentValue.minus(collateralValue.dividedBy((goalOCR.minus(currentOCR)).plus(collateralValue.dividedBy(lentValue)))).dividedBy(this.assetPrice)} ${this.assetName}`)
        return (lentValue.minus(collateralValue.dividedBy((goalOCR.minus(currentOCR)).plus(collateralValue.dividedBy(lentValue)))).dividedBy(this.assetPrice))
    }

    protected async setCollateralAssetInfo(){
        console.log(this.collateralName)
        const collateralAssetInfo = await this.#mirrorClient.collaterallOracle.getCollateralAssetInfo(this.collateralName)
        
        this.collateralPrice = new Decimal((await this.#mirrorClient.collaterallOracle.getCollateralPrice(this.collateralName)).rate)
        this.#collateralMultiplier = parseFloat(collateralAssetInfo.multiplier)
        Logger.log("The collateral price is updated to: " + this.collateralPrice.toString() +"\n By using this collateral the minimum OCR is multiplied with a factor of : " + this.#collateralMultiplier)
    }

    protected async setAssetAndCollateralInfo(){
        const CDP = await this.#mirrorClient.mint.getPosition(this.idx)
        this.#collateralInfo = CDP.collateral
        this.#assetInfo = CDP.asset
        this.#isShort = CDP.is_short
        this.#minCollateralRatio = parseFloat((await this.#mirrorClient.mint.getAssetConfig((<Token> this.#assetInfo.info ).token.contract_addr )).min_collateral_ratio)
        Logger.log(`The minimum collateral ration of asset ${this.assetName} at address ${(<Token> this.#assetInfo.info ).token.contract_addr}  / ${this.assetAdress} is ${this.#minCollateralRatio}`)

    }
}