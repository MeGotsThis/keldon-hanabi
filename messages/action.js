'use strict';

// Sent when the user performs an in-game action
// "data" example:
/*
    {
        clue: { // Not present if the type is 1 or 2
            type: 0, // 0 is a number clue, 1 is a color clue
            value: 1,
        },
        target: 1, // Either the player index of the recipient of the clue, or the card ID (e.g. the first card of the deck drawn is card #1, etc.)
        type: 0,
        // 0 is a clue
        // 1 is a play
        // 2 is a discard
        // 3 is a deck blind play (added in the emulator)
        // 4 is end game (only used by the server when enforcing a time limit)
    }
*/

// Imports
const globals  = require('../globals');
const logger   = require('../logger');
const notify   = require('../notify');
const messages = require('../messages');

const step1 = function(socket, data) {
    // Local variables
    data.gameID = socket.atTable.id;
    let end = false;
    let loss = false;

    // Validate that this table exists
    if (data.gameID in globals.currentGames === false) {
        return;
    }
    let game = globals.currentGames[data.gameID];

    // Get the index of this player
    for (let i = 0; i < game.players.length; i++) {
        if (game.players[i].userID === socket.userID) {
            data.index = i;
            break;
        }
    }
    let player = game.players[data.index];

    // Validate that it is this player's turn
    if (game.turn_player_index !== data.index) {
        return;
    }

    // There are 3 types of actions
    game.sound = null; // Remove the "fail" and "blind" states
    if (data.type === 0) {
        playerClue(data);

    } else if (data.type === 1 || data.type === 2) {
        // We are not allowed to discard while at 8 clues
        // (the client should enforce this, but do a check just in case)
        if (data.type === 2 && game.clue_num === 8) {
            return;
        }

        // Remove the card from their hand
        for (let i = 0; i < player.hand.length; i++) {
            if (player.hand[i].order === data.target) {
                player.hand.splice(i, 1);
                data.slot = player.hand.length - i + 1; // Slot 1 is the leftmost slot, but the leftmost slot is index 5
                break;
            }
        }

        if (data.type === 1) {
            playerPlayCard(data);
        } else if (data.type === 2) {
            game.clue_num++;
            playerDiscardCard(data);
        }
        playerDrawCard(data);

    } else if (data.type === 3) {
        // We are not allowed to blind play the deck unless there is only 1 card left
        // (the client should enforce this, but do a check just in case)
        if (game.deckIndex !== game.deck.length - 1) {
            return;
        }

        playerBlindPlayDeck(data);

    } else if (data.type === 4) {
        // This is a special action type sent by the server to itself when a player runs out of time
        game.strikes = 3;

        let text = game.players[game.turn_player_index].username + ' ran out of time!';
        game.actions.push({
            text: text,
        });
        notify.gameAction(data);
        logger.info('[Game ' + data.gameID + '] ' + text);

    } else {
        logger.error('Error: Unknown action type: ' + data.type);
        return;
    }

    // Send messages about the current status
    game.actions.push({
        clues: game.clue_num,
        score: game.score,
        type: 'status',
    });
    notify.gameAction(data);

    // Adjust the timer for the player that just took their turn
    if (game.timed) {
        let now = (new Date()).getTime();
        player.time -= now - game.turn_begin_time;
        player.time += globals.extraTurnTime; // A player gets an additional X seconds for making a move
        game.turn_begin_time = now;
    }

    // Increment the turn
    game.turn_num++;
    game.turn_player_index++;
    if (game.turn_player_index === game.players.length) {
        game.turn_player_index = 0;
    }

    // Check for end game states
    if (game.strikes === 3) {
        end = true;
        loss = true;

        let text = 'Players lose!';
        game.actions.push({
            text: text,
        });
        notify.gameAction(data);
        logger.info('[Game ' + data.gameID + '] ' + text);

    } else if (game.turn_num === game.end_turn_num ||
               (game.variant === 0 && game.score === 20) ||
               (game.variant === 1 && game.score === 30) ||
               (game.variant === 2 && game.score === 25) ||
               (game.variant === 3 && game.score === 30)) {

        end = true;

        let text = 'Players score ' + game.score + ' points';
        game.actions.push({
            text: text,
        });
        notify.gameAction(data);
        logger.info('[Game ' + data.gameID + '] ' + text);
    }

    // Send messages about the current turn
    game.actions.push({
        num: game.turn_num,
        type: 'turn',
        who: game.turn_player_index,
    });
    notify.gameAction(data);
    logger.info('[Game ' + data.gameID + '] It is now ' + game.players[game.turn_player_index].username + '\'s turn.');

    // Tell every client to play a sound as a notification for the action taken
    notify.gameSound(data);

    if (end) {
        messages.end_game.step1(data, loss);
        return;
    }

    // Send the "action" message to the next player
    let nextPlayerSocket = game.players[game.turn_player_index].socket;
    notify.playerAction(nextPlayerSocket, data);

    notify.allTableChange(data);
    // (this seems wasteful but this is apparently used so that you can see if it is your turn from the lobby)

    if (game.timed) {
        // Send everyone new clock values
        notify.gameTime(data);

        // Start the function that will check to see if the current player has run out of time
        // (it just got to be their turn)
        data.userID = game.players[game.turn_player_index].userID;
        data.turn_num = game.turn_num;
        setTimeout(function() {
            checkTimer(data);
        }, game.players[game.turn_player_index].time);
    }
};
exports.step1 = step1;

// Type 0 - A clue
function playerClue(data) {
    // Local variables
    let game = globals.currentGames[data.gameID];

    // Validate that there are clues available to use
    if (game.clue_num === 0) {
        return;
    }

    // Decrement the clues
    game.clue_num--;

    // Find out what cards this clue touches
    let list = [];
    for (let card of game.players[data.target].hand) {
        if (data.clue.type === 0) { // Number clue
            if (card.rank === data.clue.value) {
                list.push(card.order);
                card.touched = true;
            }
        } else if (data.clue.type === 1) { // Color clue
            // Account for rainbow cards
            if (card.suit === data.clue.value || (card.suit === 5 && game.variant === 3)) {
                list.push(card.order);
                card.touched = true;
            }
        }
    }
    if (list.length === 0) {
        logger.warn('This clue touches no cards! Something went wrong...');
        return;
    }

    // Send the "notify" message about the clue
    game.actions.push({
        clue: data.clue,
        giver: data.index,
        list: list,
        target: data.target,
        type: 'clue',
    });
    notify.gameAction(data);

    // Send the "message" message about the clue
    let text = game.players[data.index].username + ' tells ';
    text += game.players[data.target].username + ' about ';
    let words = ['', 'one', 'two', 'three', 'four', 'five'];
    text += words[list.length] + ' ';
    if (data.clue.type === 0) { // Number clue
        text += data.clue.value;
    } else if (data.clue.type === 1) { // Color clue
        text += globals.suits[data.clue.value];
    }
    if (list.length > 1) {
        text += 's';
    }
    game.actions.push({
        text: text,
    });
    notify.gameAction(data);
    logger.info('[Game ' + data.gameID + '] ' + text);
}

function playerPlayCard(data) {
    // Local variables
    let game = globals.currentGames[data.gameID];
    let card = game.deck[data.target];
    let suit = (card.suit === 5 && game.variant === 3 ? globals.suits[card.suit + 1] : globals.suits[card.suit]);

    // Find out if this successfully plays
    if (card.rank === game.stacks[card.suit] + 1) {
        // Success
        game.score++;
        game.stacks[card.suit]++;

        // Send the "notify" message about the play
        game.actions.push({
            type: 'played',
            which: {
                index: data.index,
                rank:  card.rank,
                suit:  card.suit,
                order: card.order,
            },
        });
        notify.gameAction(data);

        // Send the "message" about the play
        let text = game.players[data.index].username + ' ';
        text += 'plays ';
        text += suit + ' ' + card.rank + ' from ';
        if (data.slot === -1) {
            text += 'the deck';
        } else {
            text += 'slot #' + data.slot;
        }
        if (card.touched === false) {
            text += ' (blind)';
            game.sound = 'blind';
        }
        game.actions.push({
            text: text,
        });
        notify.gameAction(data);
        logger.info('[Game ' + data.gameID + '] ' + text);

        // Give the team a clue if a 5 was played
        if (card.rank === 5) {
            game.clue_num++;
            if (game.clue_num > 8) {
                game.clue_num = 8; // The extra clue is wasted if they are at 8 clues already
            }
        }

    } else {
        // Send the "notify" message about the strike
        game.strikes++;
        game.actions.push({
            type: 'strike',
            num:  game.strikes,
        });
        notify.gameAction(data);

        playerDiscardCard(data, true);
    }
}

function playerDiscardCard(data, failed = false) {
    // Local variables
    let game = globals.currentGames[data.gameID];
    let card = game.deck[data.target];
    let suit = (card.suit === 5 && game.variant === 3 ? globals.suits[card.suit + 1] : globals.suits[card.suit]);

    game.actions.push({
        type: 'discard',
        which: {
            index: data.index,
            rank:  card.rank,
            suit:  card.suit,
            order: data.target,
        },
    });
    notify.gameAction(data);

    let text = game.players[data.index].username + ' ';
    if (failed) {
        text += 'fails to play';
        game.sound = 'fail';
    } else {
        text += 'discards';
    }
    text += ' ' + suit + ' ' + card.rank + ' from ';
    if (data.slot === -1) {
        text += 'the bottom of the deck';
    } else {
        text += 'slot #' + data.slot;
    }
    if (failed === false && card.touched) {
        text += ' (clued)';
    }
    game.actions.push({
        text: text,
    });
    notify.gameAction(data);
    logger.info('[Game ' + data.gameID + '] ' + text);
}

// We have to use "data.index" instead of "globals.currentGames[data.gameID].turn_player_index"
// because this is used before the game starts
const playerDrawCard = function(data) {
    // Local variables
    let game = globals.currentGames[data.gameID];

    // Check to see if the deck is empty
    if (game.deckIndex >= game.deck.length) {
        // Don't draw any more cards if the deck is empty
        return;
    }

    let card = game.deck[game.deckIndex];
    card.order = game.deckIndex;
    game.players[data.index].hand.push(card);
    game.actions.push({
        type:  'draw',
        who:   data.index,
        rank:  card.rank,
        suit:  card.suit,
        order: game.deckIndex,
    });
    game.deckIndex++;

    if (game.running) {
        notify.gameAction(data);
    }

    game.actions.push({
        type: 'draw_size',
        size: game.deck.length - game.deckIndex,
    });

    if (game.running) {
        notify.gameAction(data);
    }

    // Check to see if that was the last card drawn
    if (game.deckIndex >= game.deck.length) {
        // Mark the turn upon which the game will end
        game.end_turn_num = game.turn_num + game.players.length + 1;
    }
};
exports.playerDrawCard = playerDrawCard;

function playerBlindPlayDeck(data) {
    // Local variables
    let game = globals.currentGames[data.gameID];

    // Make the player draw that card
    playerDrawCard(data);

    // Play the card freshly drawn
    data.target = game.deck.length - 1; // The final card
    data.slot = -1;
    playerPlayCard(data);
}

const checkTimer = function(data) {
    // Check to see if the game ended already
    if (data.gameID in globals.currentGames === false) {
        return;
    }

    // Local variables
    let game = globals.currentGames[data.gameID];

    // Check to see if we have made a move in the meanwhiled
    if (data.turn_num !== game.turn_num) {
        return;
    }

    // Get the index of this player
    for (let i = 0; i < game.players.length; i++) {
        if (game.players[i].userID === data.userID) {
            data.index = i;
            break;
        }
    }
    let player = game.players[data.index];
    player.time = 0;
    logger.info('Time ran out for "' + player.username + '" playing game #' + data.gameID + '.');

    // End the game
    data.type = 4;
    let fakeSocket = {
        userID: data.userID,
        atTable: {
            id: data.gameID,
        },
    };
    step1(fakeSocket, data);
};
exports.checkTimer = checkTimer;
