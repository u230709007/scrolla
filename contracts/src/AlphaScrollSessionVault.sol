// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
}

/// @dev Uniswap V2 Router02 subset. Most Monad DEXes ship a V2-compatible router.
interface IUniswapV2Router02 {
    function WETH() external view returns (address);

    function getAmountsOut(uint256 amountIn, address[] calldata path)
        external
        view
        returns (uint256[] memory amounts);

    function swapExactETHForTokensSupportingFeeOnTransferTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable;
}

/// @title AlphaScrollSessionVault
/// @notice "Double-tap to buy" without a wallet popup per trade.
///
/// The owner deposits native MON once and authorises an ephemeral session key
/// (generated in the browser) with an expiry, a per-trade cap and a total
/// budget. The session key can then only call `buy`, which swaps the owner's
/// deposit on a V2 router and sends the purchased tokens straight to the
/// owner. A leaked session key can therefore never withdraw funds; the worst
/// case is bad trades bounded by the remaining budget.
contract AlphaScrollSessionVault {
    struct Session {
        address key;
        uint64 expiry;
        uint128 maxPerTrade;
        uint128 remaining;
    }

    IUniswapV2Router02 public immutable router;
    address public immutable wrappedNative;

    mapping(address owner => uint256) public balanceOf;
    mapping(address owner => Session) public sessions;
    mapping(address key => address owner) public ownerOfKey;

    uint256 private _locked = 1;

    event Deposited(address indexed owner, uint256 amount);
    event Withdrawn(address indexed owner, uint256 amount);
    event SessionAuthorized(
        address indexed owner, address indexed key, uint64 expiry, uint128 maxPerTrade, uint128 budget
    );
    event SessionRevoked(address indexed owner, address indexed key);
    event Bought(
        address indexed owner,
        address indexed token,
        address indexed executor,
        uint256 amountIn,
        uint256 amountOut
    );

    error ZeroAmount();
    error InsufficientBalance();
    error InvalidSession();
    error SessionExpired();
    error TradeTooLarge();
    error BudgetExceeded();
    error KeyInUse();
    error TransferFailed();
    error Reentrancy();

    modifier nonReentrant() {
        if (_locked != 1) revert Reentrancy();
        _locked = 2;
        _;
        _locked = 1;
    }

    constructor(IUniswapV2Router02 router_) {
        router = router_;
        wrappedNative = router_.WETH();
    }

    // ------------------------------------------------------------------ //
    // Owner funds
    // ------------------------------------------------------------------ //

    function deposit() external payable {
        if (msg.value == 0) revert ZeroAmount();
        balanceOf[msg.sender] += msg.value;
        emit Deposited(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (balanceOf[msg.sender] < amount) revert InsufficientBalance();
        balanceOf[msg.sender] -= amount;
        _send(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    // ------------------------------------------------------------------ //
    // Session keys
    // ------------------------------------------------------------------ //

    /// @notice One wallet confirmation: deposit `msg.value - gasStipend`,
    /// forward `gasStipend` to the session key so it can pay for its own
    /// transactions, and (re)authorise it. Replaces any previous session.
    function authorizeSession(address key, uint64 expiry, uint128 maxPerTrade, uint128 budget, uint256 gasStipend)
        external
        payable
        nonReentrant
    {
        if (key == address(0) || key == msg.sender) revert InvalidSession();
        if (expiry <= block.timestamp) revert SessionExpired();
        if (maxPerTrade == 0 || budget == 0 || maxPerTrade > budget) revert InvalidSession();
        address keyOwner = ownerOfKey[key];
        if (keyOwner != address(0) && keyOwner != msg.sender) revert KeyInUse();
        if (gasStipend > msg.value) revert InsufficientBalance();

        _revoke(msg.sender);

        uint256 depositAmount = msg.value - gasStipend;
        if (depositAmount > 0) {
            balanceOf[msg.sender] += depositAmount;
            emit Deposited(msg.sender, depositAmount);
        }

        sessions[msg.sender] = Session(key, expiry, maxPerTrade, budget);
        ownerOfKey[key] = msg.sender;
        emit SessionAuthorized(msg.sender, key, expiry, maxPerTrade, budget);

        if (gasStipend > 0) _send(key, gasStipend);
    }

    function revokeSession() external {
        _revoke(msg.sender);
    }

    // ------------------------------------------------------------------ //
    // Trading
    // ------------------------------------------------------------------ //

    /// @notice Buy `token` with `amountIn` of the owner's deposit.
    /// Callable by the owner directly (no caps) or by their session key.
    function buy(address token, uint256 amountIn, uint256 amountOutMin, uint256 deadline)
        external
        nonReentrant
        returns (uint256 amountOut)
    {
        if (amountIn == 0) revert ZeroAmount();

        address owner = ownerOfKey[msg.sender];
        if (owner == address(0)) {
            owner = msg.sender; // owner trading directly
        } else {
            Session storage s = sessions[owner];
            if (s.key != msg.sender) revert InvalidSession();
            if (block.timestamp > s.expiry) revert SessionExpired();
            if (amountIn > s.maxPerTrade) revert TradeTooLarge();
            if (amountIn > s.remaining) revert BudgetExceeded();
            s.remaining -= uint128(amountIn);
        }

        if (balanceOf[owner] < amountIn) revert InsufficientBalance();
        balanceOf[owner] -= amountIn;

        address[] memory path = new address[](2);
        path[0] = wrappedNative;
        path[1] = token;

        // Measure the owner's balance delta so fee-on-transfer memecoins work.
        uint256 before = IERC20(token).balanceOf(owner);
        router.swapExactETHForTokensSupportingFeeOnTransferTokens{value: amountIn}(
            amountOutMin, path, owner, deadline
        );
        amountOut = IERC20(token).balanceOf(owner) - before;

        emit Bought(owner, token, msg.sender, amountIn, amountOut);
    }

    /// @notice Quote for the UI: expected tokens out for `amountIn` MON.
    function quote(address token, uint256 amountIn) external view returns (uint256) {
        address[] memory path = new address[](2);
        path[0] = wrappedNative;
        path[1] = token;
        return router.getAmountsOut(amountIn, path)[1];
    }

    // ------------------------------------------------------------------ //

    function _revoke(address owner) internal {
        address key = sessions[owner].key;
        if (key == address(0)) return;
        delete ownerOfKey[key];
        delete sessions[owner];
        emit SessionRevoked(owner, key);
    }

    function _send(address to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
