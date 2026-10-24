// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Test-only ERC20 that the mock router mints on swaps.
contract MockToken {
    string public name = "Mock Molandak";
    string public symbol = "MOLANDAK";
    uint8 public decimals = 18;
    mapping(address => uint256) public balanceOf;
    address public immutable minter;

    constructor() {
        minter = msg.sender;
    }

    function mint(address to, uint256 amount) external {
        require(msg.sender == minter, "not minter");
        balanceOf[to] += amount;
    }
}

/// @dev Test-only V2 router: 1 native = `rate` tokens, minted to `to`.
contract MockRouter {
    address public immutable WETH = address(0xBEEF);
    MockToken public immutable token;
    uint256 public immutable rate;

    constructor(uint256 rate_) {
        token = new MockToken();
        rate = rate_;
    }

    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory a) {
        a = new uint256[](path.length);
        a[0] = amountIn;
        a[1] = amountIn * rate;
    }

    function swapExactETHForTokensSupportingFeeOnTransferTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable {
        require(block.timestamp <= deadline, "EXPIRED");
        require(path[0] == WETH && path[1] == address(token), "PATH");
        uint256 out = msg.value * rate;
        require(out >= amountOutMin, "INSUFFICIENT_OUTPUT_AMOUNT");
        token.mint(to, out);
    }
}
