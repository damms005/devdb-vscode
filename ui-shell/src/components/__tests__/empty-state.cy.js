import Initializer from '../Initializer.vue'

describe('Initializer', () => {
  it('playground', () => {
    cy.mount(Initializer, { props: { msg: 'Hey!' } })
  })

  it('renders properly', () => {
    cy.mount(Initializer, { props: { msg: 'Hey!' } })
    cy.get('h1').should('contain', 'Hey!')
  })
})
