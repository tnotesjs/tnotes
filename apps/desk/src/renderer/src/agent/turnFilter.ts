/** 迟到的上一轮事件不能写进当前轮。 */
export function eventMatchesTurn(eventTurnId: string, currentTurnId: string): boolean {
  return currentTurnId !== '' && eventTurnId === currentTurnId
}
