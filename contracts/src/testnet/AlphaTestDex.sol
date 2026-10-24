// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Testnet-only DEX so double-tap buys work end to end on Monad testnet,
/// where no V2 router with liquidity for our feed tokens is guaranteed to exist.
/// Deployed by `npm run setup:testnet`. Do not use on mainnet.

/// @dev Plain fixed-supply ERC20. The whole supply goes to the deployer, who
/// seeds the router pool with it.
contract TestToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory name_, string memory symbol_, uint256 supply) {
        name = name_;
        symbol = symbol_;
        totalSupply = supply;
        balanceOf[msg.sender] = supply;
        emit Transfer(address(0), msg.sender, supply);
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= value, "ALLOWANCE");
            allowance[from][msg.sender] = allowed - value;
        }
        _transfer(from, to, value);
        return true;
    }

    function _transfer(address from, address to, uint256 value) internal {
        require(balanceOf[from] >= value, "BALANCE");
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }
}

/// @dev Minimal WETH9. The router keeps native MON in its pools; WMON only
/// identifies the native side of a path (path[0] on buys), as on Uniswap V2.
contract WMON {
    string public constant name = "Wrapped MON";
    string public constant symbol = "WMON";
    uint8 public constant decimals = 18;
    mapping(address => uint256) public balanceOf;

    event Deposit(address indexed dst, uint256 wad);
    event Withdrawal(address indexed src, uint256 wad);

    receive() external payable {
        deposit();
    }

    function deposit() public payable {
        balanceOf[msg.sender] += msg.value;
        emit Deposit(msg.sender, msg.value);
    }

    function withdraw(uint256 wad) external {
        require(balanceOf[msg.sender] >= wad, "BALANCE");
        balanceOf[msg.sender] -= wad;
        emit Withdrawal(msg.sender, wad);
        (bool ok,) = msg.sender.call{value: wad}("");
        require(ok, "TRANSFER");
    }
}

interface IERC20Min {
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

/// @dev Constant-product (x*y=k, 0.3% fee) MON/token pools behind the Uniswap
/// V2 Router02 functions AlphaScrollSessionVault uses, plus a sell path.
/// Only the deployer can add or remove liquidity, so there are no LP shares.
contract AlphaTestRouter {
    struct Pool {
        uint128 reserveNative;
        uint128 reserveToken;
    }

    address public immutable WETH;
    address public immutable owner;
    mapping(address token => Pool) public pools;
    address[] public tokens;

    uint256 private _locked = 1;

    event LiquidityAdded(address indexed token, uint256 nativeAmount, uint256 tokenAmount);
    event LiquidityRemoved(address indexed token, uint256 nativeAmount, uint256 tokenAmount);
    event Swap(
        address indexed token, address indexed sender, address indexed to, bool isBuy, uint256 amountIn, uint256 amountOut
    );

    modifier onlyOwner() {
        require(msg.sender == owner, "OWNER");
        _;
    }

    modifier nonReentrant() {
        require(_locked == 1, "LOCKED");
        _locked = 2;
        _;
        _locked = 1;
    }

    modifier ensure(uint256 deadline) {
        require(deadline >= block.timestamp, "EXPIRED");
        _;
    }

    constructor(address wrappedNative) {
        require(wrappedNative != address(0), "WETH");
        WETH = wrappedNative;
        owner = msg.sender;
    }

    function tokenCount() external view returns (uint256) {
        return tokens.length;
    }

    // ------------------------------------------------------------------ //
    // Liquidity (owner only)
    // ------------------------------------------------------------------ //

    /// @notice Pull `tokenAmount` from the owner (approve first) and add it with msg.value MON.
    function addLiquidity(address token, uint256 tokenAmount) external payable onlyOwner nonReentrant {
        require(msg.value > 0 && tokenAmount > 0, "AMOUNT");
        uint256 received = _pull(token, msg.sender, tokenAmount);
        Pool storage p = pools[token];
        if (p.reserveNative == 0 && p.reserveToken == 0) tokens.push(token);
        p.reserveNative += uint128(msg.value);
        p.reserveToken += uint128(received);
        emit LiquidityAdded(token, msg.value, received);
    }

    function removeLiquidity(address token) external onlyOwner nonReentrant {
        Pool memory p = pools[token];
        delete pools[token];
        _safeTransfer(token, msg.sender, p.reserveToken);
        _sendNative(msg.sender, p.reserveNative);
        emit LiquidityRemoved(token, p.reserveNative, p.reserveToken);
    }

    // ------------------------------------------------------------------ //
    // Uniswap V2 Router02 subset
    // ------------------------------------------------------------------ //

    function getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) public pure returns (uint256) {
        require(amountIn > 0, "INSUFFICIENT_INPUT_AMOUNT");
        require(reserveIn > 0 && reserveOut > 0, "INSUFFICIENT_LIQUIDITY");
        uint256 amountInWithFee = amountIn * 997;
        return (amountInWithFee * reserveOut) / (reserveIn * 1000 + amountInWithFee);
    }

    /// @dev Supports [WETH, token] (buy) and [token, WETH] (sell).
    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts) {
        require(path.length == 2, "PATH");
        amounts = new uint256[](2);
        amounts[0] = amountIn;
        if (path[0] == WETH) {
            Pool memory p = pools[path[1]];
            amounts[1] = getAmountOut(amountIn, p.reserveNative, p.reserveToken);
        } else {
            require(path[1] == WETH, "PATH");
            Pool memory p = pools[path[0]];
            amounts[1] = getAmountOut(amountIn, p.reserveToken, p.reserveNative);
        }
    }

    function swapExactETHForTokensSupportingFeeOnTransferTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable nonReentrant ensure(deadline) {
        require(path.length == 2 && path[0] == WETH, "PATH");
        address token = path[1];
        Pool storage p = pools[token];
        uint256 out = getAmountOut(msg.value, p.reserveNative, p.reserveToken);
        p.reserveNative += uint128(msg.value);
        p.reserveToken -= uint128(out);

        uint256 before = IERC20Min(token).balanceOf(to);
        _safeTransfer(token, to, out);
        require(IERC20Min(token).balanceOf(to) - before >= amountOutMin, "INSUFFICIENT_OUTPUT_AMOUNT");
        emit Swap(token, msg.sender, to, true, msg.value, out);
    }

    function swapExactTokensForETHSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external nonReentrant ensure(deadline) {
        require(path.length == 2 && path[1] == WETH, "PATH");
        address token = path[0];
        Pool storage p = pools[token];
        uint256 received = _pull(token, msg.sender, amountIn);
        uint256 out = getAmountOut(received, p.reserveToken, p.reserveNative);
        require(out >= amountOutMin, "INSUFFICIENT_OUTPUT_AMOUNT");
        p.reserveToken += uint128(received);
        p.reserveNative -= uint128(out);
        _sendNative(to, out);
        emit Swap(token, msg.sender, to, false, received, out);
    }

    // ------------------------------------------------------------------ //

    function _pull(address token, address from, uint256 amount) internal returns (uint256 received) {
        uint256 before = IERC20Min(token).balanceOf(address(this));
        (bool ok, bytes memory data) =
            token.call(abi.encodeWithSelector(IERC20Min.transferFrom.selector, from, address(this), amount));
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "TRANSFER_FROM_FAILED");
        received = IERC20Min(token).balanceOf(address(this)) - before;
    }

    function _safeTransfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(IERC20Min.transfer.selector, to, amount));
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "TRANSFER_FAILED");
    }

    function _sendNative(address to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount}("");
        require(ok, "NATIVE_TRANSFER_FAILED");
    }
}
