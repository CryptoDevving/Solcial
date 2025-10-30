use anchor_lang::prelude::*;
use anchor_lang::solana_program::system_instruction;
use anchor_lang::system_program::System;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use solana_program::pubkey; // Added import for pubkey! macro
use solana_program::rent::Rent;

declare_id!("6EsKQnDt3zQd7ttjyfEFPCdWYTjgupkv4sZsWKfPCVQR");

const MAX_POST_LENGTH: usize = 280; // Maximum character length of a post or reply
const MAX_REPORT_REASON_LENGTH: usize = 200; // Maximum character length of a report reason
const MAX_REPORTS_PER_POST: u64 = 100; // Maximum number of reports per post
const POST_FEE: u64 = 1_000_000; // 0.001 SOL in lamports for posts
const REPLY_FEE: u64 = 5_000_000; // 0.005 SOL in lamports for replies
const VOTE_FEE: u64 = 1_000_000; // 0.001 SOL in lamports for voting
const REPORT_FEE: u64 = 2_000_000; // 0.002 SOL in lamports for reporting

// SOLCIAL token configuration
const SOLCIAL_MINT: &str = "5Rbao9ekiUJbYteTjhYKif5VF95oZxfUy1ZGb5Mc9CYj";
const SOLCIAL_RECIPIENT: &str = "5n7BhkbShhh4LCKngM6z7kzKmFaM9jTmJ8XYpzSE7BXU";
const SOLCIAL_POST_FEE: u64 = 1000_000_000; // 1000 SOLCIAL tokens (assuming 9 decimals)
const SOLCIAL_REPLY_FEE: u64 = 5000_000_000; // 5000 SOLCIAL tokens
const SOLCIAL_VOTE_FEE: u64 = 1000_000_000; // 1000 SOLCIAL tokens
const SOLCIAL_REPORT_FEE: u64 = 200_000_000; // 200 SOLCIAL tokens

const ADMIN_KEY_1: Pubkey = pubkey!("HrsKTCmdRrvfsknwVwnVguWFXQpLTdgCwQ8nwfFXvvLz");
const ADMIN_KEY_2: Pubkey = pubkey!("7XeCnBHGWYxpVfd9zCoU3z8FtiSwoGZYk41jcE2sgBxW");
const ADMIN_KEY_3: Pubkey = pubkey!("5n7BhkbShhh4LCKngM6z7kzKmFaM9jTmJ8XYpzSE7BXU");
const ADMIN_KEY_4: Pubkey = pubkey!("HaNAWXNe3ZUwDKsTA8feKL43r4ViqaNAzzZGWixUvncp");

const ADMIN_KEYS: [Pubkey; 4] = [ADMIN_KEY_1, ADMIN_KEY_2, ADMIN_KEY_3, ADMIN_KEY_4];
const POST_FEE_RECIPIENT: &str = "5n7BhkbShhh4LCKngM6z7kzKmFaM9jTmJ8XYpzSE7BXU";

#[program]
pub mod solana_forum {
    use super::*;

    // Initialize the forum with a hardcoded admin
    pub fn initialize_forum(ctx: Context<InitializeForum>) -> Result<()> {
        require!(
            ADMIN_KEYS.contains(&ctx.accounts.admin.key()),
            ForumError::NotAdmin
        );

        let forum = &mut ctx.accounts.forum;
        forum.admin = ctx.accounts.admin.key();
        forum.post_count = 0;
        forum.reply_count = 0;
        forum.report_count = 0;
        forum.version = 15;

        msg!("Forum initialized by admin: {}. Version: {}", ctx.accounts.admin.key(), forum.version);
        emit!(ForumInitialized {
            admin: ctx.accounts.admin.key(),
            version: forum.version,
        });
        Ok(())
    }

    // Create a new post with a fee to the post fee recipient (SOL payment)
    pub fn create_post(ctx: Context<CreatePost>, content: String) -> Result<()> {
        require!(
            content.chars().count() <= MAX_POST_LENGTH,
            ForumError::ContentTooLong
        );
        require!(!content.is_empty(), ForumError::ContentEmpty);
        require!(
            is_valid_content(&content),
            ForumError::InvalidContent
        );
        require!(
            ctx.accounts.user.key() != Pubkey::default() && ctx.accounts.user.key() != System::id(),
            ForumError::InvalidAuthor
        );

        let rent = Rent::get()?;
        let user_data_len = ctx.accounts.user.to_account_info().data_len();
        let rent_exempt = rent.minimum_balance(user_data_len);
        let user_lamports = ctx.accounts.user.lamports();
        require!(
            user_lamports >= POST_FEE + rent_exempt,
            ForumError::InsufficientLamports
        );
        msg!("User lamports: {}. Required fee: {}. Rent exempt: {}", user_lamports, POST_FEE, rent_exempt);

        let fee_recipient_key = Pubkey::try_from(POST_FEE_RECIPIENT).map_err(|_| ForumError::InvalidFeeRecipient)?;
        require!(
            ctx.accounts.fee_recipient.key() == fee_recipient_key,
            ForumError::InvalidFeeRecipient
        );
        require!(
            ctx.accounts.fee_recipient.owner == &System::id(),
            ForumError::InvalidFeeRecipientOwner
        );
        require!(
            ctx.accounts.fee_recipient.lamports() > 0,
            ForumError::FeeRecipientNotInitialized
        );

        msg!("Transferring post fee to: {}", fee_recipient_key);
        let transfer_instruction = system_instruction::transfer(
            ctx.accounts.user.key,
            &fee_recipient_key,
            POST_FEE,
        );
        anchor_lang::solana_program::program::invoke(
            &transfer_instruction,
            &[
                ctx.accounts.user.to_account_info(),
                ctx.accounts.fee_recipient.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;

        let post = &mut ctx.accounts.post;
        let forum = &mut ctx.accounts.forum;

        post.author = ctx.accounts.user.key();
        post.content = content.clone();
        post.rating = 0;
        post.timestamp = Clock::get()?.unix_timestamp;
        post.id = forum.post_count;
        post.is_reported = false;
        post.report_count = 0;

        forum.post_count += 1;

        msg!("Post created with ID: {} by user: {}. Post PDA: {}", post.id, post.author, post.key());
        emit!(PostCreated {
            post_id: post.id,
            author: post.author,
            content,
            timestamp: post.timestamp,
            pda: post.key(),
        });
        Ok(())
    }

    // Create a new post with SOLCIAL token payment
    pub fn create_post_with_solcial(ctx: Context<CreatePostWithSolcial>, content: String) -> Result<()> {
        require!(
            content.chars().count() <= MAX_POST_LENGTH,
            ForumError::ContentTooLong
        );
        require!(!content.is_empty(), ForumError::ContentEmpty);
        require!(
            is_valid_content(&content),
            ForumError::InvalidContent
        );
        require!(
            ctx.accounts.user.key() != Pubkey::default() && ctx.accounts.user.key() != System::id(),
            ForumError::InvalidAuthor
        );

        require!(
            !ctx.accounts.user_solcial_account.is_frozen(),
            ForumError::AccountFrozen
        );
        require!(
            !ctx.accounts.solcial_recipient.is_frozen(),
            ForumError::AccountFrozen
        );
        require!(
            ctx.accounts.user_solcial_account.amount >= SOLCIAL_POST_FEE,
            ForumError::InsufficientTokens
        );

        let solcial_mint_key = Pubkey::try_from(SOLCIAL_MINT).map_err(|_| ForumError::InvalidSolcialMint)?;
        let solcial_recipient_key = Pubkey::try_from(SOLCIAL_RECIPIENT).map_err(|_| ForumError::InvalidSolcialRecipient)?;

        require!(
            ctx.accounts.solcial_mint.key() == solcial_mint_key,
            ForumError::InvalidSolcialMint
        );
        require!(
            ctx.accounts.solcial_recipient.owner == solcial_recipient_key,
            ForumError::InvalidSolcialRecipient
        );

        let cpi_accounts = Transfer {
            from: ctx.accounts.user_solcial_account.to_account_info(),
            to: ctx.accounts.solcial_recipient.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        token::transfer(cpi_ctx, SOLCIAL_POST_FEE)?;

        let post = &mut ctx.accounts.post;
        let forum = &mut ctx.accounts.forum;

        post.author = ctx.accounts.user.key();
        post.content = content.clone();
        post.rating = 0;
        post.timestamp = Clock::get()?.unix_timestamp;
        post.id = forum.post_count;
        post.is_reported = false;
        post.report_count = 0;

        forum.post_count += 1;

        msg!("Post created with SOLCIAL tokens - ID: {} by user: {}. Post PDA: {}", post.id, post.author, post.key());
        emit!(PostCreated {
            post_id: post.id,
            author: post.author,
            content,
            timestamp: post.timestamp,
            pda: post.key(),
        });
        Ok(())
    }

    // Create a new reply with a fee to the post's author (SOL payment)
    pub fn create_reply(ctx: Context<CreateReply>, content: String) -> Result<()> {
        require!(
            content.chars().count() <= MAX_POST_LENGTH,
            ForumError::ContentTooLong
        );
        require!(!content.is_empty(), ForumError::ContentEmpty);
        require!(
            is_valid_content(&content),
            ForumError::InvalidContent
        );
        require!(
            ctx.accounts.post.id < ctx.accounts.forum.post_count,
            ForumError::InvalidPostId
        );
        require!(
            ctx.accounts.user.key() != Pubkey::default() && ctx.accounts.user.key() != System::id(),
            ForumError::InvalidAuthor
        );

        let rent = Rent::get()?;
        let user_data_len = ctx.accounts.user.to_account_info().data_len();
        let rent_exempt = rent.minimum_balance(user_data_len);
        let user_lamports = ctx.accounts.user.lamports();
        require!(
            user_lamports >= REPLY_FEE + rent_exempt,
            ForumError::InsufficientLamports
        );
        msg!("User lamports: {}. Required fee: {}. Rent exempt: {}", user_lamports, REPLY_FEE, rent_exempt);

        msg!("Transferring reply fee to post author: {}", ctx.accounts.post.author);
        let transfer_instruction = system_instruction::transfer(
            ctx.accounts.user.key,
            &ctx.accounts.post.author,
            REPLY_FEE,
        );
        anchor_lang::solana_program::program::invoke(
            &transfer_instruction,
            &[
                ctx.accounts.user.to_account_info(),
                ctx.accounts.post_author.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;

        let reply = &mut ctx.accounts.reply;
        let forum = &mut ctx.accounts.forum;

        reply.author = ctx.accounts.user.key();
        reply.content = content.clone();
        reply.rating = 0;
        reply.timestamp = Clock::get()?.unix_timestamp;
        reply.post_id = ctx.accounts.post.id;
        reply.id = forum.reply_count;
        reply.is_reported = false;
        reply.report_count = 0;

        forum.reply_count += 1;

        msg!("Reply created with ID: {} to post: {} by user: {}. Reply PDA: {}", reply.id, reply.post_id, reply.author, reply.key());
        emit!(ReplyCreated {
            reply_id: reply.id,
            post_id: reply.post_id,
            author: reply.author,
            content,
            timestamp: reply.timestamp,
            pda: reply.key(),
        });
        Ok(())
    }

    // Create a new reply with SOLCIAL token payment (to post author)
    pub fn create_reply_with_solcial(ctx: Context<CreateReplyWithSolcial>, content: String) -> Result<()> {
        require!(
            content.chars().count() <= MAX_POST_LENGTH,
            ForumError::ContentTooLong
        );
        require!(!content.is_empty(), ForumError::ContentEmpty);
        require!(
            is_valid_content(&content),
            ForumError::InvalidContent
        );
        require!(
            ctx.accounts.post.id < ctx.accounts.forum.post_count,
            ForumError::InvalidPostId
        );
        require!(
            ctx.accounts.user.key() != Pubkey::default() && ctx.accounts.user.key() != System::id(),
            ForumError::InvalidAuthor
        );

        require!(
            !ctx.accounts.user_solcial_account.is_frozen(),
            ForumError::AccountFrozen
        );
        require!(
            !ctx.accounts.post_author_solcial_account.is_frozen(),
            ForumError::AccountFrozen
        );
        require!(
            ctx.accounts.user_solcial_account.amount >= SOLCIAL_REPLY_FEE,
            ForumError::InsufficientTokens
        );

        let solcial_mint_key = Pubkey::try_from(SOLCIAL_MINT).map_err(|_| ForumError::InvalidSolcialMint)?;

        require!(
            ctx.accounts.solcial_mint.key() == solcial_mint_key,
            ForumError::InvalidSolcialMint
        );
        require!(
            ctx.accounts.post_author_solcial_account.owner == ctx.accounts.post.author,
            ForumError::InvalidSolcialRecipient
        );

        let cpi_accounts = Transfer {
            from: ctx.accounts.user_solcial_account.to_account_info(),
            to: ctx.accounts.post_author_solcial_account.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        token::transfer(cpi_ctx, SOLCIAL_REPLY_FEE)?;

        let reply = &mut ctx.accounts.reply;
        let forum = &mut ctx.accounts.forum;

        reply.author = ctx.accounts.user.key();
        reply.content = content.clone();
        reply.rating = 0;
        reply.timestamp = Clock::get()?.unix_timestamp;
        reply.post_id = ctx.accounts.post.id;
        reply.id = forum.reply_count;
        reply.is_reported = false;
        reply.report_count = 0;

        forum.reply_count += 1;

        msg!("Reply created with SOLCIAL tokens - ID: {} to post: {} by user: {}. Reply PDA: {}", reply.id, reply.post_id, reply.author, reply.key());
        emit!(ReplyCreated {
            reply_id: reply.id,
            post_id: reply.post_id,
            author: reply.author,
            content,
            timestamp: reply.timestamp,
            pda: reply.key(),
        });
        Ok(())
    }

    // Rate a post with a fee to the post's author (SOL payment)
    pub fn rate_post(ctx: Context<RatePost>, is_upvote: bool) -> Result<()> {
        let forum = &ctx.accounts.forum;
        let user_key = ctx.accounts.user.key();
        let user_rating = &mut ctx.accounts.user_rating;
        let post = &mut ctx.accounts.post;

        require!(
            post.id < forum.post_count,
            ForumError::InvalidPostId
        );
        require!(
            ctx.accounts.user.key() != Pubkey::default() && ctx.accounts.user.key() != System::id(),
            ForumError::InvalidAuthor
        );

        let rent = Rent::get()?;
        let user_data_len = ctx.accounts.user.to_account_info().data_len();
        let rent_exempt = rent.minimum_balance(user_data_len);
        let user_lamports = ctx.accounts.user.lamports();
        require!(
            user_lamports >= VOTE_FEE + rent_exempt,
            ForumError::InsufficientLamports
        );
        msg!("User lamports: {}. Required vote fee: {}. Rent exempt: {}", user_lamports, VOTE_FEE, rent_exempt);

        msg!("Transferring vote fee to post author: {}", post.author);
        let transfer_instruction = system_instruction::transfer(
            ctx.accounts.user.key,
            &post.author,
            VOTE_FEE,
        );
        anchor_lang::solana_program::program::invoke(
            &transfer_instruction,
            &[
                ctx.accounts.user.to_account_info(),
                ctx.accounts.post_author.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;

        let (expected_pda, _bump) = Pubkey::find_program_address(
            &[b"rating", post.key().as_ref(), user_key.as_ref()],
            ctx.program_id,
        );
        require!(
            user_rating.key() == expected_pda,
            ForumError::InvalidPDA
        );

        let _old_rating = post.rating;
        if user_rating.has_rated {
            if user_rating.is_upvote != is_upvote {
                if user_rating.is_upvote {
                    post.rating = post.rating.saturating_sub(2);
                } else {
                    post.rating = post.rating.saturating_add(2);
                }
                user_rating.is_upvote = is_upvote;
                user_rating.rating_timestamp = Clock::get()?.unix_timestamp;
                msg!("Changed vote for post {}. New rating: {}", post.id, post.rating);
            } else {
                msg!("No change in vote for post {}. Rating unchanged: {}", post.id, post.rating);
                return Ok(());
            }
        } else {
            post.rating = post.rating.saturating_add(if is_upvote { 1 } else { -1 });
            user_rating.has_rated = true;
            user_rating.is_upvote = is_upvote;
            user_rating.rating_timestamp = Clock::get()?.unix_timestamp;
            msg!("New vote for post {}. New rating: {}", post.id, post.rating);
        }

        emit!(PostRated {
            post_id: post.id,
            user: user_key,
            is_upvote,
            new_rating: post.rating,
            timestamp: user_rating.rating_timestamp,
        });
        Ok(())
    }

    // Rate a post with SOLCIAL token payment (upvotes to post author, downvotes to SOLCIAL recipient)
    pub fn rate_post_with_solcial(ctx: Context<RatePostWithSolcial>, is_upvote: bool) -> Result<()> {
        let forum = &ctx.accounts.forum;
        let user_key = ctx.accounts.user.key();
        let user_rating = &mut ctx.accounts.user_rating;
        let post = &mut ctx.accounts.post;

        require!(
            post.id < forum.post_count,
            ForumError::InvalidPostId
        );
        require!(
            ctx.accounts.user.key() != Pubkey::default() && ctx.accounts.user.key() != System::id(),
            ForumError::InvalidAuthor
        );

        require!(
            !ctx.accounts.user_solcial_account.is_frozen(),
            ForumError::AccountFrozen
        );
        require!(
            !ctx.accounts.post_author_solcial_account.is_frozen() && !ctx.accounts.solcial_recipient.is_frozen(),
            ForumError::AccountFrozen
        );
        require!(
            ctx.accounts.user_solcial_account.amount >= SOLCIAL_VOTE_FEE,
            ForumError::InsufficientTokens
        );

        let solcial_mint_key = Pubkey::try_from(SOLCIAL_MINT).map_err(|_| ForumError::InvalidSolcialMint)?;
        let solcial_recipient_key = Pubkey::try_from(SOLCIAL_RECIPIENT).map_err(|_| ForumError::InvalidSolcialRecipient)?;

        require!(
            ctx.accounts.solcial_mint.key() == solcial_mint_key,
            ForumError::InvalidSolcialMint
        );
        require!(
            ctx.accounts.post_author_solcial_account.owner == post.author,
            ForumError::InvalidSolcialRecipient
        );
        require!(
            ctx.accounts.solcial_recipient.owner == solcial_recipient_key,
            ForumError::InvalidSolcialRecipient
        );

        let to_account = if is_upvote {
            ctx.accounts.post_author_solcial_account.to_account_info()
        } else {
            ctx.accounts.solcial_recipient.to_account_info()
        };
        let cpi_accounts = Transfer {
            from: ctx.accounts.user_solcial_account.to_account_info(),
            to: to_account,
            authority: ctx.accounts.user.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        token::transfer(cpi_ctx, SOLCIAL_VOTE_FEE)?;

        let (expected_pda, _bump) = Pubkey::find_program_address(
            &[b"rating", post.key().as_ref(), user_key.as_ref()],
            ctx.program_id,
        );
        require!(
            user_rating.key() == expected_pda,
            ForumError::InvalidPDA
        );

        let _old_rating = post.rating;
        if user_rating.has_rated {
            if user_rating.is_upvote != is_upvote {
                if user_rating.is_upvote {
                    post.rating = post.rating.saturating_sub(2);
                } else {
                    post.rating = post.rating.saturating_add(2);
                }
                user_rating.is_upvote = is_upvote;
                user_rating.rating_timestamp = Clock::get()?.unix_timestamp;
                msg!("Changed vote for post {} with SOLCIAL. New rating: {}", post.id, post.rating);
            } else {
                msg!("No change in vote for post {} with SOLCIAL. Rating unchanged: {}", post.id, post.rating);
                return Ok(());
            }
        } else {
            post.rating = post.rating.saturating_add(if is_upvote { 1 } else { -1 });
            user_rating.has_rated = true;
            user_rating.is_upvote = is_upvote;
            user_rating.rating_timestamp = Clock::get()?.unix_timestamp;
            msg!("New vote for post {} with SOLCIAL. New rating: {}", post.id, post.rating);
        }

        emit!(PostRated {
            post_id: post.id,
            user: user_key,
            is_upvote,
            new_rating: post.rating,
            timestamp: user_rating.rating_timestamp,
        });
        Ok(())
    }

    // Rate a reply with a fee to the post's author (SOL payment)
    pub fn rate_reply(ctx: Context<RateReply>, is_upvote: bool) -> Result<()> {
        let forum = &ctx.accounts.forum;
        let user_key = ctx.accounts.user.key();
        let user_rating = &mut ctx.accounts.user_rating;
        let reply = &mut ctx.accounts.reply;

        require!(
            reply.id < forum.reply_count,
            ForumError::InvalidReplyId
        );
        require!(
            reply.post_id == ctx.accounts.post.id,
            ForumError::InvalidPostId
        );
        require!(
            ctx.accounts.user.key() != Pubkey::default() && ctx.accounts.user.key() != System::id(),
            ForumError::InvalidAuthor
        );

        let rent = Rent::get()?;
        let user_data_len = ctx.accounts.user.to_account_info().data_len();
        let rent_exempt = rent.minimum_balance(user_data_len);
        let user_lamports = ctx.accounts.user.lamports();
        require!(
            user_lamports >= VOTE_FEE + rent_exempt,
            ForumError::InsufficientLamports
        );
        msg!("User lamports: {}. Required vote fee: {}. Rent exempt: {}", user_lamports, VOTE_FEE, rent_exempt);

        msg!("Transferring vote fee to post author: {}", ctx.accounts.post.author);
        let transfer_instruction = system_instruction::transfer(
            ctx.accounts.user.key,
            &ctx.accounts.post.author,
            VOTE_FEE,
        );
        anchor_lang::solana_program::program::invoke(
            &transfer_instruction,
            &[
                ctx.accounts.user.to_account_info(),
                ctx.accounts.post_author.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;

        let (expected_pda, _bump) = Pubkey::find_program_address(
            &[b"rating", reply.key().as_ref(), user_key.as_ref()],
            ctx.program_id,
        );
        require!(
            user_rating.key() == expected_pda,
            ForumError::InvalidPDA
        );

        let _old_rating = reply.rating;
        if user_rating.has_rated {
            if user_rating.is_upvote != is_upvote {
                if user_rating.is_upvote {
                    reply.rating = reply.rating.saturating_sub(2);
                } else {
                    reply.rating = reply.rating.saturating_add(2);
                }
                user_rating.is_upvote = is_upvote;
                user_rating.rating_timestamp = Clock::get()?.unix_timestamp;
                msg!("Changed vote for reply {}. New rating: {}", reply.id, reply.rating);
            } else {
                msg!("No change in vote for reply {}. Rating unchanged: {}", reply.id, reply.rating);
                return Ok(());
            }
        } else {
            reply.rating = reply.rating.saturating_add(if is_upvote { 1 } else { -1 });
            user_rating.has_rated = true;
            user_rating.is_upvote = is_upvote;
            user_rating.rating_timestamp = Clock::get()?.unix_timestamp;
            msg!("New vote for reply {}. New rating: {}", reply.id, reply.rating);
        }

        emit!(ReplyRated {
            reply_id: reply.id,
            post_id: reply.post_id,
            user: user_key,
            is_upvote,
            new_rating: reply.rating,
            timestamp: user_rating.rating_timestamp,
        });
        Ok(())
    }

    // Rate a reply with SOLCIAL token payment (upvotes to post author, downvotes to SOLCIAL recipient)
    pub fn rate_reply_with_solcial(ctx: Context<RateReplyWithSolcial>, is_upvote: bool) -> Result<()> {
        let forum = &ctx.accounts.forum;
        let user_key = ctx.accounts.user.key();
        let user_rating = &mut ctx.accounts.user_rating;
        let reply = &mut ctx.accounts.reply;

        require!(
            reply.id < forum.reply_count,
            ForumError::InvalidReplyId
        );
        require!(
            reply.post_id == ctx.accounts.post.id,
            ForumError::InvalidPostId
        );
        require!(
            ctx.accounts.user.key() != Pubkey::default() && ctx.accounts.user.key() != System::id(),
            ForumError::InvalidAuthor
        );

        require!(
            !ctx.accounts.user_solcial_account.is_frozen(),
            ForumError::AccountFrozen
        );
        require!(
            !ctx.accounts.post_author_solcial_account.is_frozen() && !ctx.accounts.solcial_recipient.is_frozen(),
            ForumError::AccountFrozen
        );
        require!(
            ctx.accounts.user_solcial_account.amount >= SOLCIAL_VOTE_FEE,
            ForumError::InsufficientTokens
        );

        let solcial_mint_key = Pubkey::try_from(SOLCIAL_MINT).map_err(|_| ForumError::InvalidSolcialMint)?;
        let solcial_recipient_key = Pubkey::try_from(SOLCIAL_RECIPIENT).map_err(|_| ForumError::InvalidSolcialRecipient)?;

        require!(
            ctx.accounts.solcial_mint.key() == solcial_mint_key,
            ForumError::InvalidSolcialMint
        );
        require!(
            ctx.accounts.post_author_solcial_account.owner == ctx.accounts.post.author,
            ForumError::InvalidSolcialRecipient
        );
        require!(
            ctx.accounts.solcial_recipient.owner == solcial_recipient_key,
            ForumError::InvalidSolcialRecipient
        );

        let to_account = if is_upvote {
            ctx.accounts.post_author_solcial_account.to_account_info()
        } else {
            ctx.accounts.solcial_recipient.to_account_info()
        };
        let cpi_accounts = Transfer {
            from: ctx.accounts.user_solcial_account.to_account_info(),
            to: to_account,
            authority: ctx.accounts.user.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        token::transfer(cpi_ctx, SOLCIAL_VOTE_FEE)?;

        let (expected_pda, _bump) = Pubkey::find_program_address(
            &[b"rating", reply.key().as_ref(), user_key.as_ref()],
            ctx.program_id,
        );
        require!(
            user_rating.key() == expected_pda,
            ForumError::InvalidPDA
        );

        let _old_rating = reply.rating;
        if user_rating.has_rated {
            if user_rating.is_upvote != is_upvote {
                if user_rating.is_upvote {
                    reply.rating = reply.rating.saturating_sub(2);
                } else {
                    reply.rating = reply.rating.saturating_add(2);
                }
                user_rating.is_upvote = is_upvote;
                user_rating.rating_timestamp = Clock::get()?.unix_timestamp;
                msg!("Changed vote for reply {} with SOLCIAL. New rating: {}", reply.id, reply.rating);
            } else {
                msg!("No change in vote for reply {} with SOLCIAL. Rating unchanged: {}", reply.id, reply.rating);
                return Ok(());
            }
        } else {
            reply.rating = reply.rating.saturating_add(if is_upvote { 1 } else { -1 });
            user_rating.has_rated = true;
            user_rating.is_upvote = is_upvote;
            user_rating.rating_timestamp = Clock::get()?.unix_timestamp;
            msg!("New vote for reply {} with SOLCIAL. New rating: {}", reply.id, reply.rating);
        }

        emit!(ReplyRated {
            reply_id: reply.id,
            post_id: reply.post_id,
            user: user_key,
            is_upvote,
            new_rating: reply.rating,
            timestamp: user_rating.rating_timestamp,
        });
        Ok(())
    }

    // Report a post with SOL payment
    pub fn report_post(ctx: Context<ReportPost>, reason: String) -> Result<()> {
        require!(
            reason.chars().count() <= MAX_REPORT_REASON_LENGTH,
            ForumError::ReportReasonTooLong
        );
        require!(!reason.is_empty(), ForumError::ReportReasonEmpty);
        require!(
            is_valid_content(&reason),
            ForumError::InvalidContent
        );
        require!(
            ctx.accounts.post.id < ctx.accounts.forum.post_count,
            ForumError::InvalidPostId
        );
        require!(
            ctx.accounts.post.report_count < MAX_REPORTS_PER_POST,
            ForumError::MaxReportsReached
        );
        require!(
            ctx.accounts.user.key() != Pubkey::default() && ctx.accounts.user.key() != System::id(),
            ForumError::InvalidAuthor
        );

        let rent = Rent::get()?;
        let user_data_len = ctx.accounts.user.to_account_info().data_len();
        let rent_exempt = rent.minimum_balance(user_data_len);
        let user_lamports = ctx.accounts.user.lamports();
        require!(
            user_lamports >= REPORT_FEE + rent_exempt,
            ForumError::InsufficientLamports
        );

        let fee_recipient_key = Pubkey::try_from(POST_FEE_RECIPIENT).map_err(|_| ForumError::InvalidFeeRecipient)?;
        require!(
            ctx.accounts.fee_recipient.key() == fee_recipient_key,
            ForumError::InvalidFeeRecipient
        );

        msg!("Transferring report fee to: {}", fee_recipient_key);
        let transfer_instruction = system_instruction::transfer(
            ctx.accounts.user.key,
            &fee_recipient_key,
            REPORT_FEE,
        );
        anchor_lang::solana_program::program::invoke(
            &transfer_instruction,
            &[
                ctx.accounts.user.to_account_info(),
                ctx.accounts.fee_recipient.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;

        let report = &mut ctx.accounts.report;
        let post = &mut ctx.accounts.post;
        let forum = &mut ctx.accounts.forum;

        report.reporter = ctx.accounts.user.key();
        report.post_id = post.id;
        report.reason = reason.clone();
        report.timestamp = Clock::get()?.unix_timestamp;
        report.id = forum.report_count;
        report.is_resolved = false;

        post.is_reported = true;
        post.report_count += 1;
        forum.report_count += 1;

        msg!("Post {} reported by user: {}. Report ID: {}. Report PDA: {}", post.id, report.reporter, report.id, report.key());
        emit!(PostReported {
            report_id: report.id,
            post_id: post.id,
            reporter: report.reporter,
            reason,
            timestamp: report.timestamp,
            pda: report.key(),
        });
        Ok(())
    }

    // Report a post with SOLCIAL token payment (to SOLCIAL recipient)
    pub fn report_post_with_solcial(ctx: Context<ReportPostWithSolcial>, reason: String) -> Result<()> {
        require!(
            reason.chars().count() <= MAX_REPORT_REASON_LENGTH,
            ForumError::ReportReasonTooLong
        );
        require!(!reason.is_empty(), ForumError::ReportReasonEmpty);
        require!(
            is_valid_content(&reason),
            ForumError::InvalidContent
        );
        require!(
            ctx.accounts.post.id < ctx.accounts.forum.post_count,
            ForumError::InvalidPostId
        );
        require!(
            ctx.accounts.post.report_count < MAX_REPORTS_PER_POST,
            ForumError::MaxReportsReached
        );
        require!(
            ctx.accounts.user.key() != Pubkey::default() && ctx.accounts.user.key() != System::id(),
            ForumError::InvalidAuthor
        );

        require!(
            !ctx.accounts.user_solcial_account.is_frozen(),
            ForumError::AccountFrozen
        );
        require!(
            !ctx.accounts.solcial_recipient.is_frozen(),
            ForumError::AccountFrozen
        );
        require!(
            ctx.accounts.user_solcial_account.amount >= SOLCIAL_REPORT_FEE,
            ForumError::InsufficientTokens
        );

        let solcial_mint_key = Pubkey::try_from(SOLCIAL_MINT).map_err(|_| ForumError::InvalidSolcialMint)?;
        let solcial_recipient_key = Pubkey::try_from(SOLCIAL_RECIPIENT).map_err(|_| ForumError::InvalidSolcialRecipient)?;

        require!(
            ctx.accounts.solcial_mint.key() == solcial_mint_key,
            ForumError::InvalidSolcialMint
        );
        require!(
            ctx.accounts.solcial_recipient.owner == solcial_recipient_key,
            ForumError::InvalidSolcialRecipient
        );

        let cpi_accounts = Transfer {
            from: ctx.accounts.user_solcial_account.to_account_info(),
            to: ctx.accounts.solcial_recipient.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        token::transfer(cpi_ctx, SOLCIAL_REPORT_FEE)?;

        let report = &mut ctx.accounts.report;
        let post = &mut ctx.accounts.post;
        let forum = &mut ctx.accounts.forum;

        report.reporter = ctx.accounts.user.key();
        report.post_id = post.id;
        report.reason = reason.clone();
        report.timestamp = Clock::get()?.unix_timestamp;
        report.id = forum.report_count;
        report.is_resolved = false;

        post.is_reported = true;
        post.report_count += 1;
        forum.report_count += 1;

        msg!("Post {} reported with SOLCIAL by user: {}. Report ID: {}. Report PDA: {}", post.id, report.reporter, report.id, report.key());
        emit!(PostReported {
            report_id: report.id,
            post_id: post.id,
            reporter: report.reporter,
            reason,
            timestamp: report.timestamp,
            pda: report.key(),
        });
        Ok(())
    }

    // Report a reply with SOL payment
    pub fn report_reply(ctx: Context<ReportReply>, reason: String) -> Result<()> {
        require!(
            reason.chars().count() <= MAX_REPORT_REASON_LENGTH,
            ForumError::ReportReasonTooLong
        );
        require!(!reason.is_empty(), ForumError::ReportReasonEmpty);
        require!(
            is_valid_content(&reason),
            ForumError::InvalidContent
        );
        require!(
            ctx.accounts.reply.id < ctx.accounts.forum.reply_count,
            ForumError::InvalidReplyId
        );
        require!(
            ctx.accounts.reply.report_count < MAX_REPORTS_PER_POST,
            ForumError::MaxReportsReached
        );
        require!(
            ctx.accounts.user.key() != Pubkey::default() && ctx.accounts.user.key() != System::id(),
            ForumError::InvalidAuthor
        );

        let rent = Rent::get()?;
        let user_data_len = ctx.accounts.user.to_account_info().data_len();
        let rent_exempt = rent.minimum_balance(user_data_len);
        let user_lamports = ctx.accounts.user.lamports();
        require!(
            user_lamports >= REPORT_FEE + rent_exempt,
            ForumError::InsufficientLamports
        );

        let fee_recipient_key = Pubkey::try_from(POST_FEE_RECIPIENT).map_err(|_| ForumError::InvalidFeeRecipient)?;
        require!(
            ctx.accounts.fee_recipient.key() == fee_recipient_key,
            ForumError::InvalidFeeRecipient
        );

        msg!("Transferring report fee to: {}", fee_recipient_key);
        let transfer_instruction = system_instruction::transfer(
            ctx.accounts.user.key,
            &fee_recipient_key,
            REPORT_FEE,
        );
        anchor_lang::solana_program::program::invoke(
            &transfer_instruction,
            &[
                ctx.accounts.user.to_account_info(),
                ctx.accounts.fee_recipient.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;

        let report = &mut ctx.accounts.report;
        let reply = &mut ctx.accounts.reply;
        let forum = &mut ctx.accounts.forum;

        report.reporter = ctx.accounts.user.key();
        report.reply_id = reply.id;
        report.reason = reason.clone();
        report.timestamp = Clock::get()?.unix_timestamp;
        report.id = forum.report_count;
        report.is_resolved = false;

        reply.is_reported = true;
        reply.report_count += 1;
        forum.report_count += 1;

        msg!("Reply {} reported by user: {}. Report ID: {}. Report PDA: {}", reply.id, report.reporter, report.id, report.key());
        emit!(ReplyReported {
            report_id: report.id,
            reply_id: reply.id,
            reporter: report.reporter,
            reason,
            timestamp: report.timestamp,
            pda: report.key(),
        });
        Ok(())
    }

    // Report a reply with SOLCIAL token payment (to SOLCIAL recipient)
    pub fn report_reply_with_solcial(ctx: Context<ReportReplyWithSolcial>, reason: String) -> Result<()> {
        require!(
            reason.chars().count() <= MAX_REPORT_REASON_LENGTH,
            ForumError::ReportReasonTooLong
        );
        require!(!reason.is_empty(), ForumError::ReportReasonEmpty);
        require!(
            is_valid_content(&reason),
            ForumError::InvalidContent
        );
        require!(
            ctx.accounts.reply.id < ctx.accounts.forum.reply_count,
            ForumError::InvalidReplyId
        );
        require!(
            ctx.accounts.reply.report_count < MAX_REPORTS_PER_POST,
            ForumError::MaxReportsReached
        );
        require!(
            ctx.accounts.user.key() != Pubkey::default() && ctx.accounts.user.key() != System::id(),
            ForumError::InvalidAuthor
        );

        require!(
            !ctx.accounts.user_solcial_account.is_frozen(),
            ForumError::AccountFrozen
        );
        require!(
            !ctx.accounts.solcial_recipient.is_frozen(),
            ForumError::AccountFrozen
        );
        require!(
            ctx.accounts.user_solcial_account.amount >= SOLCIAL_REPORT_FEE,
            ForumError::InsufficientTokens
        );

        let solcial_mint_key = Pubkey::try_from(SOLCIAL_MINT).map_err(|_| ForumError::InvalidSolcialMint)?;
        let solcial_recipient_key = Pubkey::try_from(SOLCIAL_RECIPIENT).map_err(|_| ForumError::InvalidSolcialRecipient)?;

        require!(
            ctx.accounts.solcial_mint.key() == solcial_mint_key,
            ForumError::InvalidSolcialMint
        );
        require!(
            ctx.accounts.solcial_recipient.owner == solcial_recipient_key,
            ForumError::InvalidSolcialRecipient
        );

        let cpi_accounts = Transfer {
            from: ctx.accounts.user_solcial_account.to_account_info(),
            to: ctx.accounts.solcial_recipient.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        token::transfer(cpi_ctx, SOLCIAL_REPORT_FEE)?;

        let report = &mut ctx.accounts.report;
        let reply = &mut ctx.accounts.reply;
        let forum = &mut ctx.accounts.forum;

        report.reporter = ctx.accounts.user.key();
        report.reply_id = reply.id;
        report.reason = reason.clone();
        report.timestamp = Clock::get()?.unix_timestamp;
        report.id = forum.report_count;
        report.is_resolved = false;

        reply.is_reported = true;
        reply.report_count += 1;
        forum.report_count += 1;

        msg!("Reply {} reported with SOLCIAL by user: {}. Report ID: {}. Report PDA: {}", reply.id, report.reporter, report.id, report.key());
        emit!(ReplyReported {
            report_id: report.id,
            reply_id: reply.id,
            reporter: report.reporter,
            reason,
            timestamp: report.timestamp,
            pda: report.key(),
        });
        Ok(())
    }

    // Resolve a report (admin only)
    pub fn resolve_report(ctx: Context<ResolveReport>, action_taken: String) -> Result<()> {
        require!(
            ADMIN_KEYS.contains(&ctx.accounts.admin.key()),
            ForumError::NotAdmin
        );
        require!(
            !ctx.accounts.report.is_resolved,
            ForumError::ReportAlreadyResolved
        );
        require!(
            action_taken.chars().count() <= MAX_REPORT_REASON_LENGTH,
            ForumError::ContentTooLong
        );
        require!(
            is_valid_content(&action_taken),
            ForumError::InvalidContent
        );

        let report = &mut ctx.accounts.report;
        report.is_resolved = true;
        report.resolution_timestamp = Clock::get()?.unix_timestamp;
        report.admin_action = action_taken.clone();

        msg!("Report {} resolved by admin: {}. Action taken: {}", report.id, ctx.accounts.admin.key(), report.admin_action);
        emit!(PostReportResolved {
            report_id: report.id,
            post_id: report.post_id,
            admin: ctx.accounts.admin.key(),
            action_taken,
            timestamp: report.resolution_timestamp,
        });
        Ok(())
    }

    // Resolve a reply report (admin only)
    pub fn resolve_reply_report(ctx: Context<ResolveReplyReport>, action_taken: String) -> Result<()> {
        require!(
            ADMIN_KEYS.contains(&ctx.accounts.admin.key()),
            ForumError::NotAdmin
        );
        require!(
            !ctx.accounts.report.is_resolved,
            ForumError::ReportAlreadyResolved
        );
        require!(
            action_taken.chars().count() <= MAX_REPORT_REASON_LENGTH,
            ForumError::ContentTooLong
        );
        require!(
            is_valid_content(&action_taken),
            ForumError::InvalidContent
        );

        let report = &mut ctx.accounts.report;
        report.is_resolved = true;
        report.resolution_timestamp = Clock::get()?.unix_timestamp;
        report.admin_action = action_taken.clone();

        msg!("Reply report {} resolved by admin: {}. Action taken: {}", report.id, ctx.accounts.admin.key(), report.admin_action);
        emit!(ReplyReportResolved {
            report_id: report.id,
            reply_id: report.reply_id,
            admin: ctx.accounts.admin.key(),
            action_taken,
            timestamp: report.resolution_timestamp,
        });
        Ok(())
    }

    // Delete a post (admin only) - Note: Reports cleanup would require separate function
    pub fn delete_post(ctx: Context<DeletePost>) -> Result<()> {
        require!(
            ADMIN_KEYS.contains(&ctx.accounts.admin.key()),
            ForumError::NotAdmin
        );

        let post_id = ctx.accounts.post.id;
        msg!("Post {} deleted by admin: {}", post_id, ctx.accounts.admin.key());
        emit!(PostDeleted {
            post_id,
            admin: ctx.accounts.admin.key(),
        });
        Ok(())
    }

    // Delete a reply (admin only) - Note: Reports cleanup would require separate function
    pub fn delete_reply(ctx: Context<DeleteReply>) -> Result<()> {
        require!(
            ADMIN_KEYS.contains(&ctx.accounts.admin.key()),
            ForumError::NotAdmin
        );

        let reply_id = ctx.accounts.reply.id;
        let post_id = ctx.accounts.reply.post_id;
        msg!("Reply {} to post {} deleted by admin: {}", reply_id, post_id, ctx.accounts.admin.key());
        emit!(ReplyDeleted {
            reply_id,
            post_id,
            admin: ctx.accounts.admin.key(),
        });
        Ok(())
    }

    // Close a post report (admin only)
    pub fn close_post_report(ctx: Context<ClosePostReport>) -> Result<()> {
        require!(
            ADMIN_KEYS.contains(&ctx.accounts.admin.key()),
            ForumError::NotAdmin
        );

        let report_id = ctx.accounts.report.id;
        msg!("Post report {} closed by admin: {}", report_id, ctx.accounts.admin.key());
        emit!(PostReportClosed {
            report_id,
            admin: ctx.accounts.admin.key(),
        });
        Ok(())
    }

    // Close a reply report (admin only)
    pub fn close_reply_report(ctx: Context<CloseReplyReport>) -> Result<()> {
        require!(
            ADMIN_KEYS.contains(&ctx.accounts.admin.key()),
            ForumError::NotAdmin
        );

        let report_id = ctx.accounts.report.id;
        msg!("Reply report {} closed by admin: {}", report_id, ctx.accounts.admin.key());
        emit!(ReplyReportClosed {
            report_id,
            admin: ctx.accounts.admin.key(),
        });
        Ok(())
    }

    // Close the forum (admin only)
    pub fn close_forum(ctx: Context<CloseForum>) -> Result<()> {
        require!(
            ADMIN_KEYS.contains(&ctx.accounts.admin.key()),
            ForumError::NotAdmin
        );

        msg!("Forum closed by admin: {}. Forum PDA: {}", ctx.accounts.admin.key(), ctx.accounts.forum.key());
        emit!(ForumClosed {
            admin: ctx.accounts.admin.key(),
        });
        Ok(())
    }
}

/// Validates that content contains only ASCII printable characters or whitespace
fn is_valid_content(content: &str) -> bool {
    content.chars().all(|c| c.is_ascii() && (c.is_ascii_graphic() || c.is_ascii_whitespace()))
}

#[derive(Accounts)]
pub struct InitializeForum<'info> {
    #[account(
        init,
        payer = admin,
        space = 8 + 32 + 8 + 8 + 8 + 8, // Discriminator + admin pubkey + post_count + reply_count + report_count + version
        seeds = [b"forum"],
        bump
    )]
    pub forum: Account<'info, Forum>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CreatePost<'info> {
    #[account(
        init,
        payer = user,
        space = 8 + 32 + 4 + (MAX_POST_LENGTH * 4) + 8 + 8 + 8 + 1 + 8, // Discriminator + author + string prefix + content + rating + timestamp + id + is_reported + report_count
        seeds = [b"post", forum.key().as_ref(), &forum.post_count.to_le_bytes()],
        bump
    )]
    pub post: Account<'info, Post>,
    #[account(mut)]
    pub forum: Account<'info, Forum>,
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut, constraint = fee_recipient.key() == Pubkey::try_from(POST_FEE_RECIPIENT).unwrap() @ ForumError::InvalidFeeRecipient)]
    pub fee_recipient: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CreatePostWithSolcial<'info> {
    #[account(
        init,
        payer = user,
        space = 8 + 32 + 4 + (MAX_POST_LENGTH * 4) + 8 + 8 + 8 + 1 + 8,
        seeds = [b"post", forum.key().as_ref(), &forum.post_count.to_le_bytes()],
        bump
    )]
    pub post: Account<'info, Post>,
    #[account(mut)]
    pub forum: Account<'info, Forum>,
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        mut,
        constraint = user_solcial_account.mint == solcial_mint.key() @ ForumError::InvalidSolcialMint,
        constraint = user_solcial_account.owner == user.key() @ ForumError::InvalidTokenOwner
    )]
    pub user_solcial_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = solcial_recipient.mint == solcial_mint.key() @ ForumError::InvalidSolcialMint
    )]
    pub solcial_recipient: Account<'info, TokenAccount>,
    #[account(constraint = solcial_mint.key() == Pubkey::try_from(SOLCIAL_MINT).unwrap() @ ForumError::InvalidSolcialMint)]
    pub solcial_mint: Account<'info, anchor_spl::token::Mint>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CreateReply<'info> {
    #[account(
        init,
        payer = user,
        space = 8 + 32 + 4 + (MAX_POST_LENGTH * 4) + 8 + 8 + 8 + 8 + 1 + 8,
        seeds = [b"reply", forum.key().as_ref(), &forum.reply_count.to_le_bytes()],
        bump
    )]
    pub reply: Account<'info, Reply>,
    #[account(mut)]
    pub forum: Account<'info, Forum>,
    #[account(constraint = post.id < forum.post_count @ ForumError::InvalidPostId)]
    pub post: Account<'info, Post>,
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut, constraint = post_author.key() == post.author @ ForumError::InvalidFeeRecipient)]
    pub post_author: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CreateReplyWithSolcial<'info> {
    #[account(
        init,
        payer = user,
        space = 8 + 32 + 4 + (MAX_POST_LENGTH * 4) + 8 + 8 + 8 + 8 + 1 + 8,
        seeds = [b"reply", forum.key().as_ref(), &forum.reply_count.to_le_bytes()],
        bump
    )]
    pub reply: Account<'info, Reply>,
    #[account(mut)]
    pub forum: Account<'info, Forum>,
    #[account(constraint = post.id < forum.post_count @ ForumError::InvalidPostId)]
    pub post: Account<'info, Post>,
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        mut,
        constraint = user_solcial_account.mint == solcial_mint.key() @ ForumError::InvalidSolcialMint,
        constraint = user_solcial_account.owner == user.key() @ ForumError::InvalidTokenOwner
    )]
    pub user_solcial_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = post_author_solcial_account.mint == solcial_mint.key() @ ForumError::InvalidSolcialMint,
        constraint = post_author_solcial_account.owner == post.author @ ForumError::InvalidSolcialRecipient
    )]
    pub post_author_solcial_account: Account<'info, TokenAccount>,
    #[account(constraint = solcial_mint.key() == Pubkey::try_from(SOLCIAL_MINT).unwrap() @ ForumError::InvalidSolcialMint)]
    pub solcial_mint: Account<'info, anchor_spl::token::Mint>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(is_upvote: bool)]
pub struct RatePost<'info> {
    #[account(mut, constraint = post.id < forum.post_count @ ForumError::InvalidPostId)]
    pub post: Account<'info, Post>,
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + 1 + 1 + 8,
        seeds = [b"rating", post.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub user_rating: Account<'info, UserRating>,
    #[account(mut)]
    pub user: Signer<'info>,
    pub forum: Account<'info, Forum>,
    #[account(mut, constraint = post_author.key() == post.author @ ForumError::InvalidFeeRecipient)]
    pub post_author: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(is_upvote: bool)]
pub struct RatePostWithSolcial<'info> {
    #[account(mut, constraint = post.id < forum.post_count @ ForumError::InvalidPostId)]
    pub post: Account<'info, Post>,
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + 1 + 1 + 8,
        seeds = [b"rating", post.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub user_rating: Account<'info, UserRating>,
    #[account(mut)]
    pub user: Signer<'info>,
    pub forum: Account<'info, Forum>,
    #[account(
        mut,
        constraint = user_solcial_account.mint == solcial_mint.key() @ ForumError::InvalidSolcialMint,
        constraint = user_solcial_account.owner == user.key() @ ForumError::InvalidTokenOwner
    )]
    pub user_solcial_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = post_author_solcial_account.mint == solcial_mint.key() @ ForumError::InvalidSolcialMint,
        constraint = post_author_solcial_account.owner == post.author @ ForumError::InvalidSolcialRecipient
    )]
    pub post_author_solcial_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = solcial_recipient.mint == solcial_mint.key() @ ForumError::InvalidSolcialMint
    )]
    pub solcial_recipient: Account<'info, TokenAccount>,
    #[account(constraint = solcial_mint.key() == Pubkey::try_from(SOLCIAL_MINT).unwrap() @ ForumError::InvalidSolcialMint)]
    pub solcial_mint: Account<'info, anchor_spl::token::Mint>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(is_upvote: bool)]
pub struct RateReply<'info> {
    #[account(mut, constraint = reply.id < forum.reply_count @ ForumError::InvalidReplyId)]
    pub reply: Account<'info, Reply>,
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + 1 + 1 + 8,
        seeds = [b"rating", reply.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub user_rating: Account<'info, UserRating>,
    #[account(mut)]
    pub user: Signer<'info>,
    pub forum: Account<'info, Forum>,
    #[account(constraint = reply.post_id == post.id @ ForumError::InvalidPostId)]
    pub post: Account<'info, Post>,
    #[account(mut, constraint = post_author.key() == post.author @ ForumError::InvalidFeeRecipient)]
    pub post_author: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(is_upvote: bool)]
pub struct RateReplyWithSolcial<'info> {
    #[account(mut, constraint = reply.id < forum.reply_count @ ForumError::InvalidReplyId)]
    pub reply: Account<'info, Reply>,
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + 1 + 1 + 8,
        seeds = [b"rating", reply.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub user_rating: Account<'info, UserRating>,
    #[account(mut)]
    pub user: Signer<'info>,
    pub forum: Account<'info, Forum>,
    #[account(constraint = reply.post_id == post.id @ ForumError::InvalidPostId)]
    pub post: Account<'info, Post>,
    #[account(
        mut,
        constraint = user_solcial_account.mint == solcial_mint.key() @ ForumError::InvalidSolcialMint,
        constraint = user_solcial_account.owner == user.key() @ ForumError::InvalidTokenOwner
    )]
    pub user_solcial_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = post_author_solcial_account.mint == solcial_mint.key() @ ForumError::InvalidSolcialMint,
        constraint = post_author_solcial_account.owner == post.author @ ForumError::InvalidSolcialRecipient
    )]
    pub post_author_solcial_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = solcial_recipient.mint == solcial_mint.key() @ ForumError::InvalidSolcialMint
    )]
    pub solcial_recipient: Account<'info, TokenAccount>,
    #[account(constraint = solcial_mint.key() == Pubkey::try_from(SOLCIAL_MINT).unwrap() @ ForumError::InvalidSolcialMint)]
    pub solcial_mint: Account<'info, anchor_spl::token::Mint>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ReportPost<'info> {
    #[account(
        init,
        payer = user,
        space = 8 + 32 + 8 + 4 + (MAX_REPORT_REASON_LENGTH * 4) + 8 + 8 + 1 + 8 + 4 + (MAX_REPORT_REASON_LENGTH * 4),
        seeds = [b"post_report", forum.key().as_ref(), &forum.report_count.to_le_bytes()],
        bump
    )]
    pub report: Account<'info, PostReport>,
    #[account(mut)]
    pub post: Account<'info, Post>,
    #[account(mut)]
    pub forum: Account<'info, Forum>,
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut, constraint = fee_recipient.key() == Pubkey::try_from(POST_FEE_RECIPIENT).unwrap() @ ForumError::InvalidFeeRecipient)]
    pub fee_recipient: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ReportPostWithSolcial<'info> {
    #[account(
        init,
        payer = user,
        space = 8 + 32 + 8 + 4 + (MAX_REPORT_REASON_LENGTH * 4) + 8 + 8 + 1 + 8 + 4 + (MAX_REPORT_REASON_LENGTH * 4),
        seeds = [b"post_report", forum.key().as_ref(), &forum.report_count.to_le_bytes()],
        bump
    )]
    pub report: Account<'info, PostReport>,
    #[account(mut)]
    pub post: Account<'info, Post>,
    #[account(mut)]
    pub forum: Account<'info, Forum>,
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        mut,
        constraint = user_solcial_account.mint == solcial_mint.key() @ ForumError::InvalidSolcialMint,
        constraint = user_solcial_account.owner == user.key() @ ForumError::InvalidTokenOwner
    )]
    pub user_solcial_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = solcial_recipient.mint == solcial_mint.key() @ ForumError::InvalidSolcialMint
    )]
    pub solcial_recipient: Account<'info, TokenAccount>,
    #[account(constraint = solcial_mint.key() == Pubkey::try_from(SOLCIAL_MINT).unwrap() @ ForumError::InvalidSolcialMint)]
    pub solcial_mint: Account<'info, anchor_spl::token::Mint>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ReportReply<'info> {
    #[account(
        init,
        payer = user,
        space = 8 + 32 + 8 + 4 + (MAX_REPORT_REASON_LENGTH * 4) + 8 + 8 + 1 + 8 + 4 + (MAX_REPORT_REASON_LENGTH * 4),
        seeds = [b"reply_report", forum.key().as_ref(), &forum.report_count.to_le_bytes()],
        bump
    )]
    pub report: Account<'info, ReplyReport>,
    #[account(mut)]
    pub reply: Account<'info, Reply>,
    #[account(mut)]
    pub forum: Account<'info, Forum>,
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut, constraint = fee_recipient.key() == Pubkey::try_from(POST_FEE_RECIPIENT).unwrap() @ ForumError::InvalidFeeRecipient)]
    pub fee_recipient: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ReportReplyWithSolcial<'info> {
    #[account(
        init,
        payer = user,
        space = 8 + 32 + 8 + 4 + (MAX_REPORT_REASON_LENGTH * 4) + 8 + 8 + 1 + 8 + 4 + (MAX_REPORT_REASON_LENGTH * 4),
        seeds = [b"reply_report", forum.key().as_ref(), &forum.report_count.to_le_bytes()],
        bump
    )]
    pub report: Account<'info, ReplyReport>,
    #[account(mut)]
    pub reply: Account<'info, Reply>,
    #[account(mut)]
    pub forum: Account<'info, Forum>,
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        mut,
        constraint = user_solcial_account.mint == solcial_mint.key() @ ForumError::InvalidSolcialMint,
        constraint = user_solcial_account.owner == user.key() @ ForumError::InvalidTokenOwner
    )]
    pub user_solcial_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = solcial_recipient.mint == solcial_mint.key() @ ForumError::InvalidSolcialMint
    )]
    pub solcial_recipient: Account<'info, TokenAccount>,
    #[account(constraint = solcial_mint.key() == Pubkey::try_from(SOLCIAL_MINT).unwrap() @ ForumError::InvalidSolcialMint)]
    pub solcial_mint: Account<'info, anchor_spl::token::Mint>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ResolveReport<'info> {
    #[account(mut)]
    pub report: Account<'info, PostReport>,
    pub forum: Account<'info, Forum>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ResolveReplyReport<'info> {
    #[account(mut)]
    pub report: Account<'info, ReplyReport>,
    pub forum: Account<'info, Forum>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DeletePost<'info> {
    #[account(mut, close = admin)]
    pub post: Account<'info, Post>,
    pub forum: Account<'info, Forum>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DeleteReply<'info> {
    #[account(mut, close = admin)]
    pub reply: Account<'info, Reply>,
    pub forum: Account<'info, Forum>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClosePostReport<'info> {
    #[account(mut, close = admin)]
    pub report: Account<'info, PostReport>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CloseReplyReport<'info> {
    #[account(mut, close = admin)]
    pub report: Account<'info, ReplyReport>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CloseForum<'info> {
    #[account(mut, close = admin, seeds = [b"forum"], bump)]
    pub forum: Account<'info, Forum>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[account]
pub struct Forum {
    pub admin: Pubkey,
    pub post_count: u64,
    pub reply_count: u64,
    pub report_count: u64,
    pub version: u64,
}

#[account]
pub struct Post {
    pub author: Pubkey,
    pub content: String,
    pub rating: i64,
    pub timestamp: i64,
    pub id: u64,
    pub is_reported: bool,
    pub report_count: u64,
}

#[account]
pub struct Reply {
    pub author: Pubkey,
    pub content: String,
    pub rating: i64,
    pub timestamp: i64,
    pub post_id: u64,
    pub id: u64,
    pub is_reported: bool,
    pub report_count: u64,
}

#[account]
pub struct UserRating {
    pub has_rated: bool,
    pub is_upvote: bool,
    pub rating_timestamp: i64,
}

#[account]
pub struct PostReport {
    pub reporter: Pubkey,
    pub post_id: u64,
    pub reason: String,
    pub timestamp: i64,
    pub id: u64,
    pub is_resolved: bool,
    pub resolution_timestamp: i64,
    pub admin_action: String,
}

#[account]
pub struct ReplyReport {
    pub reporter: Pubkey,
    pub reply_id: u64,
    pub reason: String,
    pub timestamp: i64,
    pub id: u64,
    pub is_resolved: bool,
    pub resolution_timestamp: i64,
    pub admin_action: String,
}

#[error_code]
pub enum ForumError {
    #[msg("Only admin can perform this action")]
    NotAdmin,
    #[msg("Content exceeds maximum length")]
    ContentTooLong,
    #[msg("Content cannot be empty")]
    ContentEmpty,
    #[msg("Invalid post ID")]
    InvalidPostId,
    #[msg("Invalid reply ID")]
    InvalidReplyId,
    #[msg("Insufficient lamports for transaction")]
    InsufficientLamports,
    #[msg("Invalid fee recipient")]
    InvalidFeeRecipient,
    #[msg("Fee recipient account not initialized")]
    FeeRecipientNotInitialized,
    #[msg("Invalid fee recipient owner")]
    InvalidFeeRecipientOwner,
    #[msg("Report reason exceeds maximum length")]
    ReportReasonTooLong,
    #[msg("Report reason cannot be empty")]
    ReportReasonEmpty,
    #[msg("Maximum number of reports for post reached")]
    MaxReportsReached,
    #[msg("Report already resolved")]
    ReportAlreadyResolved,
    #[msg("Invalid author address")]
    InvalidAuthor,
    #[msg("Invalid SOLCIAL mint")]
    InvalidSolcialMint,
    #[msg("Invalid SOLCIAL recipient")]
    InvalidSolcialRecipient,
    #[msg("Token account is frozen")]
    AccountFrozen,
    #[msg("Insufficient tokens for transaction")]
    InsufficientTokens,
    #[msg("Invalid token owner")]
    InvalidTokenOwner,
    #[msg("Invalid content characters")]
    InvalidContent,
    #[msg("Invalid PDA")]
    InvalidPDA,
}

#[event]
pub struct ForumInitialized {
    pub admin: Pubkey,
    pub version: u64,
}

#[event]
pub struct PostCreated {
    pub post_id: u64,
    pub author: Pubkey,
    pub content: String,
    pub timestamp: i64,
    pub pda: Pubkey,
}

#[event]
pub struct ReplyCreated {
    pub reply_id: u64,
    pub post_id: u64,
    pub author: Pubkey,
    pub content: String,
    pub timestamp: i64,
    pub pda: Pubkey,
}

#[event]
pub struct PostRated {
    pub post_id: u64,
    pub user: Pubkey,
    pub is_upvote: bool,
    pub new_rating: i64,
    pub timestamp: i64,
}

#[event]
pub struct ReplyRated {
    pub reply_id: u64,
    pub post_id: u64,
    pub user: Pubkey,
    pub is_upvote: bool,
    pub new_rating: i64,
    pub timestamp: i64,
}

#[event]
pub struct PostReported {
    pub report_id: u64,
    pub post_id: u64,
    pub reporter: Pubkey,
    pub reason: String,
    pub timestamp: i64,
    pub pda: Pubkey,
}

#[event]
pub struct ReplyReported {
    pub report_id: u64,
    pub reply_id: u64,
    pub reporter: Pubkey,
    pub reason: String,
    pub timestamp: i64,
    pub pda: Pubkey,
}

#[event]
pub struct PostReportResolved {
    pub report_id: u64,
    pub post_id: u64,
    pub admin: Pubkey,
    pub action_taken: String,
    pub timestamp: i64,
}

#[event]
pub struct ReplyReportResolved {
    pub report_id: u64,
    pub reply_id: u64,
    pub admin: Pubkey,
    pub action_taken: String,
    pub timestamp: i64,
}

#[event]
pub struct PostDeleted {
    pub post_id: u64,
    pub admin: Pubkey,
}

#[event]
pub struct ReplyDeleted {
    pub reply_id: u64,
    pub post_id: u64,
    pub admin: Pubkey,
}

#[event]
pub struct PostReportClosed {
    pub report_id: u64,
    pub admin: Pubkey,
}

#[event]
pub struct ReplyReportClosed {
    pub report_id: u64,
    pub admin: Pubkey,
}

#[event]
pub struct ForumClosed {
    pub admin: Pubkey,
}
