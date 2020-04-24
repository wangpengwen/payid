import { Request, Response, NextFunction } from 'express'

import { getAllPaymentInfoFromDatabase } from '../data-access/payIds'
import { urlToPayId } from '../services/utils'
import { AddressInformation } from '../types/database'
import HttpStatus from '../types/httpStatus'
import {
  PaymentInformation,
  AddressDetailType,
  CryptoAddressDetails,
  AchAddressDetails,
} from '../types/publicAPI'
import {
  AcceptMediaType,
  getPreferredPaymentInfo,
  parseAcceptMediaType,
} from '../utils/acceptHeader'

import handleHttpError from './errors'

/**
 * Returns the best payment information associated with a payId for a set of sorted
 * Accept types.
 *
 * Returns undefined if payment infomation could not be found.
 *
 * @param - payId The PayID to retrieve payment information for
 * @param - sortedAcceptTypes An array of AcceptTypes, sorted by preference
 */
async function getPaymentInfoForAcceptTypes(
  payId: string,
  sortedAcceptTypes: AcceptMediaType[],
): Promise<
  | {
      acceptType: AcceptMediaType
      paymentInformation: AddressInformation
    }
  | undefined
> {
  if (!sortedAcceptTypes.length) {
    return undefined
  }

  // TODO:(tedkalaw) Improve this query
  const allPaymentInformation = await getAllPaymentInfoFromDatabase(payId)
  return getPreferredPaymentInfo(allPaymentInformation, sortedAcceptTypes)
}

/**
 * Resolves inbound requests to a PayID to their
 * respective ledger addresses or other payment information required.
 *
 * @param req - Contains PayID and payment network header
 * @param res - Stores payment information to be returned to the client
 * @param next - Passes req/res to next middleware
 */
export default async function getPaymentInfo(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  /**
   * NOTE: if you plan to expose your PayID with a port number, you
   * should use:
   *  const payIdUrl =
   *  `${req.protocol}://${req.hostname}:${Config.publicAPIPort}${req.url}`
   */
  // TODO(aking): stop hardcoding HTTPS. We should at minimum be using ${req.protocol}
  // TODO:(hbergren) Write a helper function for this and test it?
  const payIdUrl = `https://${req.hostname}${req.url}`
  let payId: string
  try {
    payId = urlToPayId(payIdUrl)
  } catch (err) {
    return handleHttpError(HttpStatus.BadRequest, err.message, res, err)
  }

  // This overload isn't mentioned in the express documentation, but if there are no
  // args provided, an array of types sorted by preference is returned
  // https://github.com/jshttp/accepts/blob/master/index.js#L96
  const acceptHeaderTypes = req.accepts()

  if (!acceptHeaderTypes.length) {
    return handleHttpError(
      HttpStatus.BadRequest,
      `Missing Accept header. Must have an Accept header of the form "application/{payment_network}(-{environment})+json".
      Examples:
      - 'Accept: application/xrpl-mainnet+json'
      - 'Accept: application/btc-testnet+json'
      - 'Accept: application/ach+json'
      `,
      res,
    )
  }

  let parsedAcceptTypes: AcceptMediaType[] = []
  try {
    parsedAcceptTypes = acceptHeaderTypes.map((type) =>
      parseAcceptMediaType(type),
    )
  } catch (error) {
    // TODO:(tkalaw): Should we mention all of the invalid types?
    return handleHttpError(
      400,
      `Invalid Accept header. Must be of the form "application/{payment_network}(-{environment})+json".
      Examples:
      - 'Accept: application/xrpl-mainnet+json'
      - 'Accept: application/btc-testnet+json'
      - 'Accept: application/ach+json'
      `,
      res,
    )
  }

  // TODO: If Accept is just application/json, just return all addresses, for all environments?
  const result = await getPaymentInfoForAcceptTypes(payId, parsedAcceptTypes)

  // TODO:(hbergren) Distinguish between missing PayID in system, and missing address for paymentNetwork/environment.
  // Or is `application/json` the appropriate response Content-Type?
  if (result === undefined) {
    let message = `Payment information for ${payId} could not be found.`
    if (parsedAcceptTypes.length === 1) {
      // When we only have a single accept type, we can give a more detailed error message
      const { paymentNetwork, environment } = parsedAcceptTypes[0]
      message = `Payment information for ${payId} in ${paymentNetwork} on ${environment} could not be found.`
    }

    return handleHttpError(HttpStatus.NotFound, message, res)
  }

  const { acceptType, paymentInformation } = result
  // Set the content-type to the media type corresponding to the returned address
  res.set('Content-Type', acceptType.mediaType)

  // TODO:(hbergren) Create a helper function for this?
  let response: PaymentInformation = {
    addressDetailType: AddressDetailType.CryptoAddress,
    addressDetails: paymentInformation.details as CryptoAddressDetails,
  }
  if (paymentInformation.payment_network === 'ACH') {
    response = {
      addressDetailType: AddressDetailType.AchAddress,
      addressDetails: paymentInformation.details as AchAddressDetails,
    }
  }

  // Store response information (or information to be used in other middlewares)
  // TODO:(hbergren), come up with a less hacky way to pipe around data than global state.
  res.locals.payId = payId
  res.locals.paymentInformation = response
  res.locals.response = response

  return next()
}
