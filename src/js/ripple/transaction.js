// Transactions
//
//  Construction:
//    remote.transaction()  // Build a transaction object.
//     .offer_create(...)   // Set major parameters.
//     .set_flags()         // Set optional parameters.
//     .on()                // Register for events.
//     .submit();           // Send to network.
//
//  Events:
// 'success' : Transaction submitted without error.
// 'error' : Error submitting transaction.
// 'proposed' : Advisory proposed status transaction.
// - A client should expect 0 to multiple results.
// - Might not get back. The remote might just forward the transaction.
// - A success could be reverted in final.
// - local error: other remotes might like it.
// - malformed error: local server thought it was malformed.
// - The client should only trust this when talking to a trusted server.
// 'final' : Final status of transaction.
// - Only expect a final from dishonest servers after a tesSUCCESS or ter*.
// 'lost' : Gave up looking for on ledger_closed.
// 'pending' : Transaction was not found on ledger_closed.
// 'state' : Follow the state of a transaction.
//    'client_submitted'     - Sent to remote
//     |- 'remoteError'      - Remote rejected transaction.
//      \- 'client_proposed' - Remote provisionally accepted transaction.
//       |- 'client_missing' - Transaction has not appeared in ledger as expected.
//       | |\- 'client_lost' - No longer monitoring missing transaction.
//       |/
//       |- 'tesSUCCESS'     - Transaction in ledger as expected.
//       |- 'ter...'         - Transaction failed.
//       \- 'tec...'         - Transaction claimed fee only.
//
// Notes:
// - All transactions including those with local and malformed errors may be
//   forwarded anyway.
// - A malicous server can:
//   - give any proposed result.
//     - it may declare something correct as incorrect or something correct as incorrect.
//     - it may not communicate with the rest of the network.
//   - may or may not forward.
//

var EventEmitter     = require('events').EventEmitter;
var util             = require('util');

var sjcl             = require('../../../build/sjcl');

var Amount           = require('./amount').Amount;
var Currency         = require('./amount').Currency;
var UInt160          = require('./amount').UInt160;
var Seed             = require('./seed').Seed;
var SerializedObject = require('./serializedobject').SerializedObject;

var config           = require('./config');

// A class to implement transactions.
// - Collects parameters
// - Allow event listeners to be attached to determine the outcome.
function Transaction(remote) {
  EventEmitter.call(this);

  var self  = this;

  this.remote                 = remote;
  this._secret                = void(0);
  this._build_path            = false;

  // Transaction data.
  this.tx_json                = { Flags: 0 };

  this.hash                   = void(0);

  // ledger_current_index was this when transaction was submited.
  this.submit_index           = void(0);  

  // Under construction.
  this.state                  = void(0);  

  this.finalized              = false;
  this._previous_signing_hash = void(0);
};

util.inherits(Transaction, EventEmitter);

// XXX This needs to be determined from the network.
Transaction.fees = {
  default         : Amount.from_json('10'),
  nickname_create : Amount.from_json('1000'),
  offer           : Amount.from_json('10'),
};

Transaction.flags = {
  AccountSet : {
    RequireDestTag          : 0x00010000,
    OptionalDestTag         : 0x00020000,
    RequireAuth             : 0x00040000,
    OptionalAuth            : 0x00080000,
    DisallowXRP             : 0x00100000,
    AllowXRP                : 0x00200000,
  },

  OfferCreate : {
    Passive                 : 0x00010000,
    ImmediateOrCancel       : 0x00020000,
    FillOrKill              : 0x00040000,
    Sell                    : 0x00080000,
  },

  Payment : {
    NoRippleDirect          : 0x00010000,
    PartialPayment          : 0x00020000,
    LimitQuality            : 0x00040000,
  },
};

Transaction.formats = require('./binformat').tx;

Transaction.HASH_SIGN         = 0x53545800;
Transaction.HASH_SIGN_TESTNET = 0x73747800;

Transaction.prototype.consts = {
  'telLOCAL_ERROR'  : -399,
  'temMALFORMED'    : -299,
  'tefFAILURE'      : -199,
  'terRETRY'        : -99,
  'tesSUCCESS'      : 0,
  'tecCLAIMED'      : 100,
};

Transaction.prototype.isTelLocal = function (ter) {
  return ter >= this.consts.telLOCAL_ERROR && ter < this.consts.temMALFORMED;
};

Transaction.prototype.isTemMalformed = function (ter) {
  return ter >= this.consts.temMALFORMED && ter < this.consts.tefFAILURE;
};

Transaction.prototype.isTefFailure = function (ter) {
  return ter >= this.consts.tefFAILURE && ter < this.consts.terRETRY;
};

Transaction.prototype.isTerRetry = function (ter) {
  return ter >= this.consts.terRETRY && ter < this.consts.tesSUCCESS;
};

Transaction.prototype.isTepSuccess = function (ter) {
  return ter >= this.consts.tesSUCCESS;
};

Transaction.prototype.isTecClaimed = function (ter) {
  return ter >= this.consts.tecCLAIMED;
};

Transaction.prototype.isRejected = function (ter) {
  return this.isTelLocal(ter) || this.isTemMalformed(ter) || this.isTefFailure(ter);
};

Transaction.prototype.set_state = function (state) {
  if (this.state !== state) {
    this.state  = state;
    this.emit('state', state);
  }
};

/**
 * TODO
 * Actually do this right
 */

Transaction.prototype.get_fee = function() {
  return Transaction.fees['default'].to_json();
};

/**
 * Attempts to complete the transaction for submission.
 *
 * This function seeks to fill out certain fields, such as Fee and
 * SigningPubKey, which can be determined by the library based on network
 * information and other fields.
 */
Transaction.prototype.complete = function () {
  var tx_json = this.tx_json;

  if (tx_json.Fee === void(0) && this.remote.local_fee) {
    tx_json.Fee = Transaction.fees['default'].to_json();
  }

  if (tx_json.SigningPubKey === void(0) && (!this.remote || this.remote.local_signing)) {
    var seed = Seed.from_json(this._secret);
    var key = seed.get_key(this.tx_json.Account);
    tx_json.SigningPubKey = key.to_hex_pub();
  }

  return this.tx_json;
};

Transaction.prototype.serialize = function () {
  return SerializedObject.from_json(this.tx_json);
};

Transaction.prototype.signing_hash = function () {
  var prefix = config.testnet
    ? Transaction.HASH_SIGN_TESTNET
    : Transaction.HASH_SIGN;

  return SerializedObject.from_json(this.tx_json).signing_hash(prefix);
};

Transaction.prototype.sign = function () {
  var seed = Seed.from_json(this._secret);
  var hash = this.signing_hash();

  if (this.tx_json.TxnSignature && hash === this._previous_signing_hash) {
    return;
  }

  var key  = seed.get_key(this.tx_json.Account);
  var sig  = key.sign(hash, 0);
  var hex  = sjcl.codec.hex.fromBits(sig).toUpperCase();

  this.tx_json.TxnSignature = hex;
};

Transaction.prototype._hasTransactionListeners = function() {
  return this.listeners('final').length
      || this.listeners('lost').length
      || this.listeners('pending').length
};


//
// Set options for Transactions
//

// --> build: true, to have server blindly construct a path.
//
// "blindly" because the sender has no idea of the actual cost except that is must be less than send max.
Transaction.prototype.build_path = function (build) {
  this._build_path = build;

  return this;
}

// tag should be undefined or a 32 bit integer.   
// YYY Add range checking for tag.
Transaction.prototype.destination_tag = function (tag) {
  if (tag !== void(0)) {
    this.tx_json.DestinationTag = tag;
  }

  return this;
}

Transaction._path_rewrite = function (path) {
  var path_new  = [];

  for (var i=0, l=path.length; i<l; i++) {
    var node     = path[i];
    var node_new = {};

    if ('account' in node)
      node_new.account  = UInt160.json_rewrite(node.account);

    if ('issuer' in node)
      node_new.issuer   = UInt160.json_rewrite(node.issuer);

    if ('currency' in node)
      node_new.currency = Currency.json_rewrite(node.currency);

    path_new.push(node_new);
  }

  return path_new;
}

Transaction.prototype.path_add = function (path) {
  this.tx_json.Paths  = this.tx_json.Paths || [];
  this.tx_json.Paths.push(Transaction._path_rewrite(path));

  return this;
}

// --> paths: undefined or array of path
// A path is an array of objects containing some combination of: account, currency, issuer
Transaction.prototype.paths = function (paths) {
  for (var i=0, l=paths.length; i<l; i++) {
    this.path_add(paths[i]);
  }

  return this;
}

// If the secret is in the config object, it does not need to be provided.
Transaction.prototype.secret = function (secret) {
  this._secret = secret;
}

Transaction.prototype.send_max = function (send_max) {
  if (send_max) {
    this.tx_json.SendMax = Amount.json_rewrite(send_max);
  }

  return this;
}

// tag should be undefined or a 32 bit integer.   
// YYY Add range checking for tag.
Transaction.prototype.source_tag = function (tag) {
  if (tag) {
    this.tx_json.SourceTag = tag;
  }

  return this;
}

// --> rate: In billionths.
Transaction.prototype.transfer_rate = function (rate) {
  this.tx_json.TransferRate = Number(rate);

  if (this.tx_json.TransferRate < 1e9) {
    throw new Error('invalidTransferRate');
  }

  return this;
}

// Add flags to a transaction.
// --> flags: undefined, _flag_, or [ _flags_ ]
Transaction.prototype.set_flags = function (flags) {
  if (flags) {
    var transaction_flags = Transaction.flags[this.tx_json.TransactionType];

    // We plan to not define this field on new Transaction.
    if (this.tx_json.Flags === void(0)) {
      this.tx_json.Flags = 0;
    }

    var flag_set = Array.isArray(flags) ? flags : [ flags ];

    for (var index in flag_set) {
      if (!flag_set.hasOwnProperty(index)) continue;

      var flag = flag_set[index];

      if (flag in transaction_flags) {
        this.tx_json.Flags += transaction_flags[flag];
      } else {
        // XXX Immediately report an error or mark it.
      }
    }
  }

  return this;
}

//
// Transactions
//

Transaction.prototype._account_secret = function (account) {
  // Fill in secret from remote, if available.
  return this.remote.secrets[account];
};

// Options:
//  .domain()           NYI
//  .flags()
//  .message_key()      NYI
//  .transfer_rate()
//  .wallet_locator()   NYI
//  .wallet_size()      NYI
Transaction.prototype.account_set = function (src) {
  this._secret                  = this._account_secret(src);
  this.tx_json.TransactionType  = 'AccountSet';
  this.tx_json.Account          = UInt160.json_rewrite(src);

  return this;
};

Transaction.prototype.claim = function (src, generator, public_key, signature) {
  this._secret                 = this._account_secret(src);
  this.tx_json.TransactionType = 'Claim';
  this.tx_json.Generator       = generator;
  this.tx_json.PublicKey       = public_key;
  this.tx_json.Signature       = signature;

  return this;
};

Transaction.prototype.offer_cancel = function (src, sequence) {
  this._secret                 = this._account_secret(src);
  this.tx_json.TransactionType = 'OfferCancel';
  this.tx_json.Account         = UInt160.json_rewrite(src);
  this.tx_json.OfferSequence   = Number(sequence);

  return this;
};

// Options:
//  .set_flags()
// --> expiration : if not undefined, Date or Number
// --> cancel_sequence : if not undefined, Sequence
Transaction.prototype.offer_create = function (src, taker_pays, taker_gets, expiration, cancel_sequence) {
  this._secret                 = this._account_secret(src);
  this.tx_json.TransactionType = 'OfferCreate';
  this.tx_json.Account         = UInt160.json_rewrite(src);
  this.tx_json.TakerPays       = Amount.json_rewrite(taker_pays);
  this.tx_json.TakerGets       = Amount.json_rewrite(taker_gets);

  if (this.remote.local_fee) {
    this.tx_json.Fee = Transaction.fees.offer.to_json();
  }

  if (expiration) {
    this.tx_json.Expiration = expiration instanceof Date
    ? expiration.getTime()
    : Number(expiration);
  }

  if (cancel_sequence) {
    this.tx_json.OfferSequence = Number(cancel_sequence);
  }

  return this;
};

Transaction.prototype.password_fund = function (src, dst) {
  this._secret                 = this._account_secret(src);
  this.tx_json.TransactionType = 'PasswordFund';
  this.tx_json.Destination     = UInt160.json_rewrite(dst);

  return this;
}

Transaction.prototype.password_set = function (src, authorized_key, generator, public_key, signature) {
  this._secret                 = this._account_secret(src);
  this.tx_json.TransactionType = 'PasswordSet';
  this.tx_json.RegularKey      = authorized_key;
  this.tx_json.Generator       = generator;
  this.tx_json.PublicKey       = public_key;
  this.tx_json.Signature       = signature;

  return this;
}

// Construct a 'payment' transaction.
//
// When a transaction is submitted:
// - If the connection is reliable and the server is not merely forwarding and is not malicious,
// --> src : UInt160 or String
// --> dst : UInt160 or String
// --> deliver_amount : Amount or String.
//
// Options:
//  .paths()
//  .build_path()
//  .destination_tag()
//  .path_add()
//  .secret()
//  .send_max()
//  .set_flags()
//  .source_tag()
Transaction.prototype.payment = function (src, dst, deliver_amount) {
  this._secret                 = this._account_secret(src);
  this.tx_json.TransactionType = 'Payment';
  this.tx_json.Account         = UInt160.json_rewrite(src);
  this.tx_json.Amount          = Amount.json_rewrite(deliver_amount);
  this.tx_json.Destination     = UInt160.json_rewrite(dst);

  return this;
}

Transaction.prototype.ripple_line_set = function (src, limit, quality_in, quality_out) {
  this._secret                 = this._account_secret(src);
  this.tx_json.TransactionType = 'TrustSet';
  this.tx_json.Account         = UInt160.json_rewrite(src);

  // Allow limit of 0 through.
  if (limit !== undefined)
    this.tx_json.LimitAmount  = Amount.json_rewrite(limit);

  if (quality_in)
    this.tx_json.QualityIn    = quality_in;

  if (quality_out)
    this.tx_json.QualityOut   = quality_out;

  // XXX Throw an error if nothing is set.

  return this;
};

Transaction.prototype.wallet_add = function (src, amount, authorized_key, public_key, signature) {
  this._secret                  = this._account_secret(src);
  this.tx_json.TransactionType  = 'WalletAdd';
  this.tx_json.Amount           = Amount.json_rewrite(amount);
  this.tx_json.RegularKey       = authorized_key;
  this.tx_json.PublicKey        = public_key;
  this.tx_json.Signature        = signature;

  return this;
};

// Submit a transaction to the network.
// XXX Don't allow a submit without knowing ledger_index.
// XXX Have a network canSubmit(), post events for following.
// XXX Also give broader status for tracking through network disconnects.
// callback = function (status, info) {
//   // status is final status.  Only works under a ledger_accepting conditions.
//   switch status:
//    case 'tesSUCCESS': all is well.
//    case 'tejSecretUnknown': unable to sign transaction - secret unknown
//    case 'tejServerUntrusted': sending secret to untrusted server.
//    case 'tejInvalidAccount': locally detected error.
//    case 'tejLost': locally gave up looking
//    default: some other TER
// }

Transaction.prototype.submit = function (callback) {
  var self = this;

  this.callback = (typeof callback === 'function') ? callback : function(){};

  this.once('error', function transaction_error(error, message) {
    self.callback(error, message);
  });

  this.once('success', function transaction_success(message) {
    self.callback(null, message);
  });

  var account = this.tx_json.Account;

  if (typeof account !== 'string') {
    this.emit('error', {
      error:          'tejInvalidAccount',
      error_message:  'Account is unspecified'
    });
  } else {
    // YYY Might check paths for invalid accounts.
    this.remote.get_account(account).submit(this);
  }

  return this;
}

exports.Transaction = Transaction;

// vim:sw=2:sts=2:ts=8:et
