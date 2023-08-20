import 'reactflow/dist/style.css'

import {
  Background,
  Connection,
  Edge,
  EdgeChange,
  Node,
  NodeChange,
  Panel,
  ReactFlow,
  ReactFlowInstance,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  getConnectedEdges,
  getIncomers,
  getOutgoers,
  updateEdge,
} from 'reactflow'
import { Hook, HooksConfig, METHODS } from '../../../client/collection'
import { CollectionRouteData } from '../../../routes'
import { HOOK_NODE_TYPE } from '../../../components/hook-node'
import HooksSearch from '../../../components/hooks-search'
import React from 'preact/compat'
import { SERVICE_NODE_TYPE } from '../../../components/service-node'
import nodeTypes from '../../../lib/node-types'
import randomStr from '../../../lib/random-str'
import styles from './hooks.module.css'
import { useRouteLoaderData } from 'react-router-dom'

const initialNodes = [
  {
    data: {},
    id: 'service',
    position: { x: 500, y: 300 },
    type: SERVICE_NODE_TYPE,
  },
]

const DEBOUNCE_THRESHOLD = 500

class Tree {
  private edges: Edge[]
  private nodes: Node[]

  constructor(edges: Edge[], nodes: Node[]) {
    this.edges = edges
    this.nodes = nodes
  }

  ancestor(connection: Edge) {
    return this.edges.find(
      (edge) => edge.source !== 'service' && edge.target === connection?.source
    )
  }

  *ancestry(targetHandle: string) {
    const visited: Record<string, true> = {}
    let currentConnection = this.edges.find(
      (edge) => edge.targetHandle === targetHandle
    )

    while (currentConnection) {
      if (visited[currentConnection.id]) {
        throw new Error('Circular connection detected')
      }

      visited[currentConnection.id] = true

      const node = this.nodes.find(
        (node) => node.id === currentConnection?.source
      )

      yield [node, currentConnection]

      currentConnection = this.ancestor(currentConnection)
    }
  }

  descendant(connection: Edge) {
    return this.edges.find(
      (edge) => edge.target !== 'service' && edge.source === connection?.target
    )
  }

  *descent(sourceHandle: string) {
    const visited: Record<string, true> = {}

    let currentConnection = this.edges.find(
      (edge) => edge.sourceHandle === sourceHandle
    )

    while (currentConnection) {
      if (visited[currentConnection.id]) {
        throw new Error('Circular connection detected')
      }

      visited[currentConnection.id] = true

      const node = this.nodes.find(
        (node) => node.id === currentConnection?.target
      )

      yield [node, currentConnection]

      currentConnection = this.descendant(currentConnection)
    }
  }
}

function CollectionHooks() {
  const { collection } = useRouteLoaderData('collection') as CollectionRouteData

  const saveDebounce = React.useRef<ReturnType<typeof setTimeout>>()
  const edgeUpdateSuccessful = React.useRef(true)

  const [nodes, setNodes] = React.useState<Node[]>(initialNodes)
  const [edges, setEdges] = React.useState<Edge[]>([])

  const [flow, setFlow] = React.useState<ReactFlowInstance>()

  const [existingHooks, setExistingHooks] = React.useState<HooksConfig>()
  const [currentHooks, setCurrentHooks] = React.useState<HooksConfig>()

  const onNodesChange = React.useCallback(
    (changes: NodeChange[]) =>
      setNodes((nodes) => applyNodeChanges(changes, nodes)),
    []
  )

  const onEdgesChange = React.useCallback(
    (changes: EdgeChange[]) =>
      setEdges((edges) => applyEdgeChanges(changes, edges)),
    []
  )

  const onEdgeUpdateStart = React.useCallback(() => {
    edgeUpdateSuccessful.current = false
  }, [])

  const onEdgeUpdate = React.useCallback(
    (oldEdge: Edge, newConnection: Connection) => {
      edgeUpdateSuccessful.current = true
      setEdges((els) => updateEdge(oldEdge, newConnection, els))
    },
    []
  )

  const onEdgeUpdateEnd = React.useCallback((_: Edge, edge: Edge) => {
    if (!edgeUpdateSuccessful.current) {
      setEdges((eds) => eds.filter((e) => e.id !== edge.id))
    }

    edgeUpdateSuccessful.current = true
  }, [])

  const onConnect = React.useCallback((connection: Connection) => {
    setEdges((edges) => {
      edges = edges.filter((edge) => {
        if (connection.source === 'service') {
          return edge.sourceHandle !== connection.sourceHandle
        }

        return (
          `${edge.target}-${edge.targetHandle}` !==
          `${connection.target}-${connection.targetHandle}`
        )
      })
      return addEdge(connection, edges)
    })
  }, [])

  const onNodesDelete = React.useCallback(
    (deleted: Node[]) => {
      setEdges(
        deleted.reduce((acc, node) => {
          const incomers = getIncomers(node, nodes, edges)
          const outgoers = getOutgoers(node, nodes, edges)
          const connectedEdges = getConnectedEdges([node], edges)

          const remainingEdges = acc.filter(
            (edge) => !connectedEdges.includes(edge)
          )

          const createdEdges = incomers.flatMap(({ id: source }) =>
            outgoers.map(({ id: target }) => ({
              id: `${source}->${target}`,
              source,
              target,
            }))
          )

          return [...remainingEdges, ...createdEdges]
        }, edges)
      )
    },
    [nodes, edges]
  )

  async function saveHooks() {
    await collection.setHooks(currentHooks!)
    setExistingHooks(currentHooks)
  }

  function addHook(hookId: string) {
    setNodes((nodes) => [
      ...nodes,
      {
        data: { id: hookId },
        id: randomStr(),
        position: { x: 100, y: 200 },
        type: HOOK_NODE_TYPE,
      },
    ])
  }

  React.useEffect(() => {
    if (!flow) {
      return
    }

    // load editor state
    collection.editor().then((editor) => {
      setNodes(editor.nodes)
      setEdges(editor.edges)
      flow.setViewport(editor.viewport)
    })

    collection.hooks().then((hooks) => setExistingHooks(hooks))
  }, [collection, flow])

  React.useEffect(() => {
    // save editor state
    if (!flow) {
      return
    }

    clearTimeout(saveDebounce.current)
    saveDebounce.current = setTimeout(() => {
      collection.setEditor(flow.toObject())
    }, DEBOUNCE_THRESHOLD)
  }, [collection, edges, flow, nodes])

  React.useEffect(() => {
    // resolve hooks
    const tree = new Tree(edges, nodes)

    const serviceHooks: HooksConfig = {
      after: {},
      before: {},
    }

    try {
      for (const method of METHODS) {
        const targetHandle = `before-${method}`
        const beforeHooks: Hook[] = []

        for (const [node] of tree.ancestry(targetHandle)) {
          beforeHooks.push([node?.data.id])
        }

        serviceHooks['before'][method] = beforeHooks.reverse()

        const sourceHandle = `after-${method}`
        const afterHooks: Hook[] = []

        for (const [node] of tree.descent(sourceHandle)) {
          afterHooks.push([node?.data.id])
        }

        serviceHooks['after'][method] = afterHooks
      }

      setCurrentHooks(serviceHooks)
    } catch (err) {
      console.error('Error resolving hooks', err)
      // [ ] Handle error
    }
  }, [edges, nodes])

  const hooksChanged =
    JSON.stringify(currentHooks) !== JSON.stringify(existingHooks)

  return (
    <div className={styles.flowWrapper}>
      <ReactFlow
        nodeTypes={nodeTypes}
        nodes={nodes}
        onConnect={onConnect}
        onEdgesChange={onEdgesChange}
        onEdgeUpdate={onEdgeUpdate}
        onEdgeUpdateStart={onEdgeUpdateStart}
        onEdgeUpdateEnd={onEdgeUpdateEnd}
        onNodesChange={onNodesChange}
        onNodesDelete={onNodesDelete}
        edges={edges}
        onInit={(instance: ReactFlowInstance) => setFlow(instance)}
      >
        <Background />
        <Panel position="top-left">
          <HooksSearch onSelect={addHook} />
        </Panel>

        <Panel position="top-right">
          <div className="text-end">
            <button
              className="primary"
              disabled={!hooksChanged}
              onClick={saveHooks}
            >
              Save & activate hooks
            </button>
            {hooksChanged && (
              <p className="m-0 text-secondary">
                Changes detected in the hooks
              </p>
            )}
          </div>
        </Panel>
      </ReactFlow>
    </div>
  )
}

export default CollectionHooks
