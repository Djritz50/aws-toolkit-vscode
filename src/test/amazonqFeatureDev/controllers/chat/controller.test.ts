/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode'
import * as assert from 'assert'
import * as path from 'path'
import sinon from 'sinon'
import { waitUntil } from '../../../../shared/utilities/timeoutUtils'
import { ControllerSetup, createController, createSession } from '../../utils'
import { FollowUpTypes, createUri } from '../../../../amazonqFeatureDev/types'
import { Session } from '../../../../amazonqFeatureDev/session/session'
import { Prompter } from '../../../../shared/ui/prompter'
import { assertTelemetry, toFile } from '../../../testUtil'
import { SelectedFolderNotInWorkspaceFolderError } from '../../../../amazonqFeatureDev/errors'
import { PrepareRefinementState } from '../../../../amazonqFeatureDev/session/sessionState'
import { FeatureDevClient } from '../../../../amazonqFeatureDev/client/featureDev'

describe('Controller', () => {
    const tabID = '123'
    const conversationID = '456'
    const uploadID = '789'

    let session: Session
    let controllerSetup: ControllerSetup

    before(() => {
        sinon.stub(performance, 'now').returns(0)
    })

    beforeEach(async () => {
        controllerSetup = await createController()
        session = await createSession({ messenger: controllerSetup.messenger, conversationID, tabID, uploadID })
    })

    afterEach(() => {
        sinon.restore()
    })

    describe('openDiff', async () => {
        async function openDiff(filePath: string, deleted = false) {
            const executeDiff = sinon.stub(vscode.commands, 'executeCommand').returns(Promise.resolve(undefined))
            controllerSetup.emitters.openDiff.fire({ tabID, filePath, deleted })

            // Wait until the controller has time to process the event
            await waitUntil(() => {
                return Promise.resolve(executeDiff.callCount > 0)
            }, {})

            return executeDiff
        }

        it('uses empty file when file is not found locally', async () => {
            sinon.stub(controllerSetup.sessionStorage, 'getSession').resolves(session)
            const executedDiff = await openDiff(path.join('src', 'mynewfile.js'))
            assert.strictEqual(
                executedDiff.calledWith(
                    'vscode.diff',
                    createUri('empty', tabID),
                    createUri(path.join(uploadID, 'src', 'mynewfile.js'), tabID)
                ),
                true
            )

            assertTelemetry('amazonq_isReviewedChanges', { amazonqConversationId: conversationID, enabled: true })
        })

        it('uses file location when file is found locally and /src is not available', async () => {
            sinon.stub(controllerSetup.sessionStorage, 'getSession').resolves(session)
            const newFileLocation = path.join(controllerSetup.workspaceFolder.uri.fsPath, 'mynewfile.js')
            toFile('', newFileLocation)
            const executedDiff = await openDiff('mynewfile.js')
            assert.strictEqual(
                executedDiff.calledWith(
                    'vscode.diff',
                    vscode.Uri.file(newFileLocation),
                    createUri(path.join(uploadID, 'mynewfile.js'), tabID)
                ),
                true
            )

            assertTelemetry('amazonq_isReviewedChanges', { amazonqConversationId: conversationID, enabled: true })
        })

        it('uses file location when file is found locally and /src is available', async () => {
            sinon.stub(controllerSetup.sessionStorage, 'getSession').resolves(session)
            const newFileLocation = path.join(controllerSetup.workspaceFolder.uri.fsPath, 'src', 'mynewfile.js')
            toFile('', newFileLocation)
            const executedDiff = await openDiff(path.join('src', 'mynewfile.js'))
            assert.strictEqual(
                executedDiff.calledWith(
                    'vscode.diff',
                    vscode.Uri.file(newFileLocation),
                    createUri(path.join(uploadID, 'src', 'mynewfile.js'), tabID)
                ),
                true
            )

            assertTelemetry('amazonq_isReviewedChanges', { amazonqConversationId: conversationID, enabled: true })
        })

        it('uses file location when file is found locally and source folder was picked', async () => {
            sinon.stub(controllerSetup.sessionStorage, 'getSession').resolves(session)
            const newFileLocation = path.join(controllerSetup.workspaceFolder.uri.fsPath, 'foo', 'fi', 'mynewfile.js')
            toFile('', newFileLocation)
            sinon.stub(vscode.workspace, 'getWorkspaceFolder').returns(controllerSetup.workspaceFolder)
            session.config.sourceRoot = path.join(controllerSetup.workspaceFolder.uri.fsPath, 'foo', 'fi')
            const executedDiff = await openDiff(path.join('foo', 'fi', 'mynewfile.js'))
            assert.strictEqual(
                executedDiff.calledWith(
                    'vscode.diff',
                    vscode.Uri.file(newFileLocation),
                    createUri(path.join(uploadID, 'foo', 'fi', 'mynewfile.js'), tabID)
                ),
                true
            )

            assertTelemetry('amazonq_isReviewedChanges', { amazonqConversationId: conversationID, enabled: true })
        })
    })

    describe('modifyDefaultSourceFolder', () => {
        async function modifyDefaultSourceFolder(sourceRoot: string) {
            const promptStub = sinon.stub(Prompter.prototype, 'prompt').resolves(vscode.Uri.file(sourceRoot))
            controllerSetup.emitters.followUpClicked.fire({
                tabID,
                followUp: {
                    type: FollowUpTypes.ModifyDefaultSourceFolder,
                },
            })

            // Wait until the controller has time to process the event
            await waitUntil(() => {
                return Promise.resolve(promptStub.callCount > 0)
            }, {})
        }

        it('fails if selected folder is not under a workspace folder', async () => {
            sinon.stub(vscode.workspace, 'getWorkspaceFolder').returns(undefined)
            const messengerSpy = sinon.spy(controllerSetup.messenger, 'sendAnswer')
            await modifyDefaultSourceFolder('../../')
            assert.deepStrictEqual(
                messengerSpy.calledWith({
                    tabID,
                    type: 'answer',
                    message: new SelectedFolderNotInWorkspaceFolderError().message,
                }),
                true
            )
            assert.deepStrictEqual(
                messengerSpy.calledWith({
                    tabID,
                    type: 'system-prompt',
                    followUps: sinon.match.any,
                }),
                true
            )
        })

        it('accepts valid source folders under a workspace root', async () => {
            sinon.stub(controllerSetup.sessionStorage, 'getSession').resolves(session)
            sinon.stub(vscode.workspace, 'getWorkspaceFolder').returns(controllerSetup.workspaceFolder)
            const expectedSourceRoot = path.join(controllerSetup.workspaceFolder.uri.fsPath, 'src')
            await modifyDefaultSourceFolder(expectedSourceRoot)
            assert.strictEqual(session.config.sourceRoot, expectedSourceRoot)
            assert.strictEqual(session.config.workspaceRoot, controllerSetup.workspaceFolder.uri.fsPath)
        })
    })

    describe('processChatItemVotedMessage', () => {
        async function processChatItemVotedMessage(vote: 'upvote' | 'downvote') {
            const initialState = new PrepareRefinementState(
                {
                    conversationId: conversationID,
                    proxyClient: new FeatureDevClient(),
                    sourceRoot: '',
                    workspaceRoot: '',
                },
                '',
                tabID
            )
            const newSession = await createSession({
                messenger: controllerSetup.messenger,
                sessionState: initialState,
                conversationID,
                tabID,
                uploadID,
            })
            const getSessionStub = sinon.stub(controllerSetup.sessionStorage, 'getSession').resolves(newSession)
            controllerSetup.emitters.processChatItemVotedMessage.fire({
                tabID,
                messageID: '',
                vote,
            })

            // Wait until the controller has time to process the event
            await waitUntil(() => {
                return Promise.resolve(getSessionStub.callCount > 0)
            }, {})
        }

        it('incoming upvoted message sends telemetry', async () => {
            await processChatItemVotedMessage('upvote')

            assertTelemetry('amazonq_approachThumbsUp', { amazonqConversationId: conversationID, result: 'Succeeded' })
        })

        it('incoming downvoted message sends telemetry', async () => {
            await processChatItemVotedMessage('downvote')

            assertTelemetry('amazonq_approachThumbsDown', {
                amazonqConversationId: conversationID,
                result: 'Succeeded',
            })
        })
    })

    describe('newPlan', () => {
        async function newPlanClicked() {
            const getSessionStub = sinon.stub(controllerSetup.sessionStorage, 'getSession').resolves(session)

            controllerSetup.emitters.followUpClicked.fire({
                tabID,
                followUp: {
                    type: FollowUpTypes.NewPlan,
                },
            })

            // Wait until the controller has time to process the event
            await waitUntil(() => {
                return Promise.resolve(getSessionStub.callCount > 0)
            }, {})
        }

        it('end chat telemetry is sent', async () => {
            await newPlanClicked()

            assertTelemetry('amazonq_endChat', { amazonqConversationId: conversationID, result: 'Succeeded' })
        })
    })
})
